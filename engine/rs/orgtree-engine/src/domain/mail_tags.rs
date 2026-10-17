//! Custom tags for mail addressed to the user; policy is separate from routing.
use anyhow::Result;
use serde_json::{json, Value};

pub const MAX_TAGS: usize = 8;

#[nolog]
pub fn key(label: &str) -> String { label.trim().to_lowercase() }

#[nolog]
pub fn normalize(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(value) = value.filter(|v| !v.is_null()) else { return Ok(Vec::new()) };
    let Some(values) = value.as_array() else { crate::refuse!(BadRequest,"tags must be a list of strings"); };
    if values.len() > MAX_TAGS { crate::refuse!(BadRequest,"at most 8 tags per mail"); }
    let mut labels=Vec::new(); let mut keys=std::collections::HashSet::new();
    for value in values {
        let Some(label)=value.as_str() else { crate::refuse!(BadRequest,"tags must be strings"); };
        let label=label.trim(); let len=label.chars().count();
        if len==0 || len>32 || label.chars().any(char::is_control) {
            crate::refuse!(BadRequest,"each tag needs 1-32 characters after trimming, without control characters");
        }
        if keys.insert(key(label)) { labels.push(label.to_string()); }
    }
    Ok(labels)
}

#[nolog]
pub fn recipient(to: &str, tags: &[String]) -> Result<()> {
    if !tags.is_empty() && to.trim().trim_start_matches('@')!="user" {
        crate::refuse!(BadRequest,"tags are only for mail to the user; send this recipient an untagged message");
    }
    Ok(())
}

/// Runs inside the mail insert transaction. Sort catalog keys to avoid
/// opposite-order tag sets deadlocking; membership retains sender order.
#[nolog]
pub async fn attach(tx: &tokio_postgres::Transaction<'_>, org: i64, mail: i64, tags: &[String]) -> Result<()> {
    let mut catalog:Vec<_>=tags.iter().map(|label|(key(label),label)).collect();
    catalog.sort_by(|a,b|a.0.cmp(&b.0));
    for (key,label) in catalog {
        tx.execute("INSERT INTO ot.mail_tags(org_id,key,label) VALUES($1,$2,$3) ON CONFLICT(org_id,key) DO NOTHING",&[&org,&key,label]).await?;
    }
    for (ordinal,label) in tags.iter().enumerate() {
        tx.execute("INSERT INTO ot.mail_tag_links(mail_id,org_id,tag_key,ordinal) VALUES($1,$2,$3,$4)",
            &[&mail,&org,&key(label),&(ordinal as i16)]).await?;
    }
    Ok(())
}

/// Baseline extraction: one active filter, as before the multi-select request.
#[nolog]
pub fn filter_keys(tags:&[String])->Result<Vec<String>> {
    let labels=normalize(Some(&json!(tags.iter().take(1).collect::<Vec<_>>())))?;
    Ok(labels.iter().map(|s|key(s)).collect())
}

/// Exact tag matching happens before the indexed cursor window, not after
/// the user's ordinary 200-message archive window has already discarded it.
#[nolog]
pub async fn window(client: &tokio_postgres::Client, org:i64, tag:&str, before:Option<i64>) -> Result<Value> {
    let keys=filter_keys(&[tag.to_string()])?;
    let key=&keys[0]; let before=before.unwrap_or(i64::MAX);
    if before<1 { crate::refuse!(BadRequest,"mail cursor must be a positive id"); }
    let rows=client.query("SELECT m.id,to_jsonb(m)||jsonb_build_object('tags',ot.mail_tag_labels(m.id))
        FROM ot.mail_tag_links l JOIN ot.mail m ON m.id=l.mail_id AND m.org_id=l.org_id
        WHERE l.org_id=$1 AND l.tag_key=$2 AND l.mail_id<$3 AND m.recipient_kind='user' AND m.state IN ('pending','read')
        ORDER BY l.mail_id DESC LIMIT 201",&[&org,&key,&before]).await?;
    let more=rows.len()>200;let mut pending=Vec::new();let mut delivered=Vec::new();let mut cursor=None;
    for row in rows.into_iter().take(200) {
        cursor=Some(row.get::<_,i64>(0).to_string());let raw:Value=row.get(1);
        let entry=crate::feed::compute::mail_entry(&raw);
        if raw["state"]=="pending" { pending.push(entry); } else { delivered.push(entry); }
    }
    Ok(json!({"pending":pending,"delivered":delivered,"sent":[],"next_cursor":if more {cursor} else {None}}))
}

/// Bounded suggestions; the editable filter can still name any exact tag.
#[nolog]
pub async fn choices(client:&tokio_postgres::Client,org:i64,prefix:&str) -> Result<Vec<String>> {
    if prefix.chars().any(char::is_control) { return Ok(Vec::new()); }
    let prefix=key(prefix).replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_")+"%";
    Ok(client.query("SELECT label FROM ot.mail_tags WHERE org_id=$1 AND key LIKE $2 ORDER BY key LIMIT 200",&[&org,&prefix])
        .await?.into_iter().map(|r|r.get(0)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn trim_dedupe_case_insensitively_keep_first_spelling() {
        assert_eq!(normalize(Some(&json!([" Alpha Build ","alpha build","Progress"]))).unwrap(),vec!["Alpha Build","Progress"]);
    }
    #[test]
    fn eight_tags_allowed_ninth_refused() {
        assert_eq!(normalize(Some(&json!(["a","b","c","d","e","f","g","h"]))).unwrap().len(),8);
        assert!(normalize(Some(&json!(["a","b","c","d","e","f","g","h","i"]))).is_err());
    }
    #[test]
    fn length_counts_characters_not_utf8_bytes_and_blank_refused() {
        assert!(normalize(Some(&json!(["\u{e9}".repeat(32)]))).is_ok());
        assert!(normalize(Some(&json!(["x".repeat(33)]))).is_err());
        assert!(normalize(Some(&json!(["   "]))).is_err());
    }
    #[test]
    fn shape_requires_strings_in_an_array() {
        for v in [json!("build"),json!([1]),json!({})] { assert!(normalize(Some(&v)).is_err()); }
        assert!(normalize(None).unwrap().is_empty());
        assert!(normalize(Some(&json!([]))).unwrap().is_empty());
    }
    #[test]
    fn tagged_recipients_are_only_user_but_untagged_routes_unchanged() {
        let tags=vec!["alpha build".to_string()];
        assert!(recipient("user",&tags).is_ok());assert!(recipient(" @user ",&tags).is_ok());
        for to in ["peer","@org:other","@net:remote"] {
            let e=recipient(to,&tags).expect_err("tagged non-user delivery must refuse before transport");
            assert!(e.to_string().contains("only for mail to the user"));
            assert!(recipient(to,&[]).is_ok());
        }
    }
    #[test]
    fn inbox_projection_carries_joined_labels_without_tagging_legacy_mail() {
        let old=json!({"uid":"old","sender":"lead","body":"old","kind":"message","created_at":"2026-10-17T00:00:00Z"});
        let mut tagged=old.clone();tagged["tags"]=json!(["Alpha Build"]);
        assert_eq!(crate::feed::compute::mail_entry(&tagged)["tags"],json!(["Alpha Build"]));
        assert!(crate::feed::compute::mail_entry(&old).get("tags").is_none());
    }
    #[test]
    fn filter_multiple_tags_keep_every_normalized_key() {
        assert_eq!(filter_keys(&[" Alpha Build ".into(),"Progress".into(),"alpha build".into()]).unwrap(),
            vec!["alpha build","progress"]);
    }
    #[test]
    fn filter_selection_is_not_limited_by_eight_tags_per_message() {
        let tags:Vec<String>=(0..20).map(|i|format!("tag{i}")).collect();
        assert_eq!(filter_keys(&tags).unwrap().len(),20);
    }
    #[test]
    fn filter_rejects_invalid_later_selected_tags_too() {
        assert!(filter_keys(&["valid".into(),"".into()]).is_err());
        assert!(filter_keys(&["valid".into(),"x".repeat(33)]).is_err());
    }
    #[test]
    fn filter_empty_and_single_tag_controls() {
        assert!(filter_keys(&[]).unwrap().is_empty());
        assert_eq!(filter_keys(&[" Alpha Build ".into()]).unwrap(),vec!["alpha build"]);
    }

}
