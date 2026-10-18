//! Custom tags for mail addressed to the user; policy is separate from routing.
use anyhow::Result;
use serde_json::{json, Value};

pub const MAX_TAGS: usize = 8;

#[nolog]
pub fn key(label: &str) -> String {
    label.trim().to_lowercase()
}

#[nolog]
pub fn normalize(value: Option<&Value>) -> Result<Vec<String>> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        crate::refuse!(BadRequest, "tags must be a list of strings");
    };
    if values.len() > MAX_TAGS {
        crate::refuse!(BadRequest, "at most 8 tags per mail");
    }
    let mut labels = Vec::new();
    let mut keys = std::collections::HashSet::new();
    for value in values {
        let Some(label) = value.as_str() else {
            crate::refuse!(BadRequest, "tags must be strings");
        };
        let label = label.trim();
        let len = label.chars().count();
        if len == 0 || len > 32 || label.chars().any(char::is_control) {
            crate::refuse!(
                BadRequest,
                "each tag needs 1-32 characters after trimming, without control characters"
            );
        }
        if keys.insert(key(label)) {
            labels.push(label.to_string());
        }
    }
    Ok(labels)
}

#[nolog]
pub fn recipient(to: &str, tags: &[String]) -> Result<()> {
    if !tags.is_empty() && to.trim().trim_start_matches('@') != "user" {
        crate::refuse!(
            BadRequest,
            "tags are only for mail to the user; send this recipient an untagged message"
        );
    }
    Ok(())
}

/// Runs inside the mail insert transaction. Sort catalog keys to avoid
/// opposite-order tag sets deadlocking; membership retains sender order.
#[nolog]
pub async fn attach(
    tx: &tokio_postgres::Transaction<'_>,
    org: i64,
    mail: i64,
    tags: &[String],
) -> Result<()> {
    let mut catalog: Vec<_> = tags.iter().map(|label| (key(label), label)).collect();
    catalog.sort_by(|a, b| a.0.cmp(&b.0));
    for (key, label) in catalog {
        tx.execute("INSERT INTO ot.mail_tags(org_id,key,label) VALUES($1,$2,$3) ON CONFLICT(org_id,key) DO NOTHING",&[&org,&key,label]).await?;
    }
    for (ordinal, label) in tags.iter().enumerate() {
        tx.execute(
            "INSERT INTO ot.mail_tag_links(mail_id,org_id,tag_key,ordinal) VALUES($1,$2,$3,$4)",
            &[&mail, &org, &key(label), &(ordinal as i16)],
        )
        .await?;
    }
    Ok(())
}

/// Filter selections are not limited by the per-message eight-tag cap.
#[nolog]
pub fn filter_keys(tags: &[String]) -> Result<Vec<String>> {
    let mut seen = std::collections::HashSet::new();
    let mut keys = Vec::new();
    for label in tags {
        // Reuse label validation one label at a time, before Unicode lowercase expansion.
        for label in normalize(Some(&json!([label])))? {
            let k = key(&label);
            if seen.insert(k.clone()) {
                keys.push(k);
            }
        }
    }
    Ok(keys)
}

/// Exact tag matching happens before the indexed cursor window, not after
/// the user's ordinary 200-message archive window has already discarded it.
#[nolog]
pub async fn window(
    client: &tokio_postgres::Client,
    org: i64,
    tag: &str,
    before: Option<i64>,
) -> Result<Value> {
    window_many(client, org, &[tag.to_string()], before).await
}

#[nolog]
pub async fn window_many(
    client: &tokio_postgres::Client,
    org: i64,
    tags: &[String],
    before: Option<i64>,
) -> Result<Value> {
    let keys = filter_keys(tags)?;
    let before = before.unwrap_or(i64::MAX);
    if before < 1 {
        crate::refuse!(BadRequest, "mail cursor must be a positive id");
    }
    if keys.is_empty() {
        let (pending, delivered, sent) = crate::feed::compute::user_mail(client, org).await?;
        let values = |rows: Vec<(i64, Value)>| rows.into_iter().map(|(_, m)| m).collect::<Vec<_>>();
        return Ok(
            json!({"pending":values(pending),"delivered":values(delivered),"sent":values(sent)}),
        );
    }
    // More selected tags is valid, but a mail can carry only eight distinct tags.
    if keys.len() > MAX_TAGS {
        let mut result=json!({"pending":[],"delivered":[],"sent":[],"next_cursor":null});
        add_unread_summary(client,org,&keys,&mut result).await?;
        return Ok(result);
    }
    let rows=client.query("SELECT m.id,to_jsonb(m)||jsonb_build_object('tags',ot.mail_tag_labels(m.id))
        FROM ot.mail_tag_links l JOIN ot.mail m ON m.id=l.mail_id AND m.org_id=l.org_id
        WHERE l.org_id=$1 AND l.tag_key=$2 AND l.mail_id<$3 AND m.recipient_kind='user' AND m.state IN ('pending','read')
          AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
            AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL)
            OR NOT EXISTS (SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))
          AND NOT EXISTS (SELECT 1 FROM unnest($4::text[]) wanted(key)
              WHERE NOT EXISTS (SELECT 1 FROM ot.mail_tag_links match_tag
                  WHERE match_tag.mail_id=m.id AND match_tag.tag_key=wanted.key))
        ORDER BY l.mail_id DESC LIMIT 201",&[&org,&keys[0],&before,&keys]).await?;
    let more = rows.len() > 200;
    let mut pending = Vec::new();
    let mut delivered = Vec::new();
    let mut cursor = None;
    for row in rows.into_iter().take(200) {
        cursor = Some(row.get::<_, i64>(0).to_string());
        let raw: Value = row.get(1);
        let entry = crate::feed::compute::mail_entry(&raw);
        if raw["state"] == "pending" {
            pending.push(entry);
        } else {
            delivered.push(entry);
        }
    }
    let mut result=json!({"pending":pending,"delivered":delivered,"sent":[],"next_cursor":if more {cursor} else {None}});
    add_unread_summary(client,org,&keys,&mut result).await?;
    Ok(result)
}

/// Aggregate only the current unread set, never materialize retained history or
/// count a bounded client page. The oldest target is global, before tag filtering.
#[nolog]
async fn add_unread_summary(client:&tokio_postgres::Client,org:i64,keys:&[String],result:&mut Value)->Result<()> {
    let row=client.query_one("WITH unread AS MATERIALIZED (
        SELECT m.id,m.uid,m.created_at,NOT EXISTS (SELECT 1 FROM unnest($2::text[]) wanted(key)
          WHERE NOT EXISTS (SELECT 1 FROM ot.mail_tag_links l WHERE l.mail_id=m.id AND l.tag_key=wanted.key)) AS matches
        FROM ot.mail m WHERE m.org_id=$1 AND m.recipient_kind='user' AND m.state='pending'
        AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%'
          AND COALESCE(m.ev->>'variant','') <> 'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL)
          OR NOT EXISTS (SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb)))
        SELECT count(*) FILTER (WHERE NOT matches),
          (SELECT uid FROM unread ORDER BY created_at,id LIMIT 1) FROM unread",&[&org,&keys]).await?;
    result["hidden_unread"]=json!(row.get::<_,i64>(0));
    result["oldest_unread_id"]=json!(row.get::<_,Option<String>>(1));
    Ok(())
}

/// Cursor-page distinct used keys with indexed seeks, not a scan of old mail.
/// The cursor follows scanned keys even when the manual search has no matches.
#[nolog]
pub async fn choices_page(
    client: &tokio_postgres::Client,
    org: i64,
    query: &str,
    after: Option<&str>,
) -> Result<Value> {
    let query = key(query);
    let rows=client.query("WITH RECURSIVE used(tag_key,n) AS (
        (SELECT l.tag_key,1 FROM ot.mail_tag_links l WHERE l.org_id=$1 AND ($2::text IS NULL OR l.tag_key>$2)
          ORDER BY l.tag_key LIMIT 1)
        UNION ALL
        SELECT next.tag_key,u.n+1 FROM used u CROSS JOIN LATERAL (
          SELECT l.tag_key FROM ot.mail_tag_links l WHERE l.org_id=$1 AND l.tag_key>u.tag_key
          ORDER BY l.tag_key LIMIT 1) next WHERE u.n<201)
        SELECT u.tag_key,t.label FROM used u JOIN ot.mail_tags t ON t.org_id=$1 AND t.key=u.tag_key ORDER BY u.n",
        &[&org,&after]).await?;
    let more = rows.len() > 200;
    let mut labels = Vec::new();
    let mut cursor = None;
    for row in rows.into_iter().take(200) {
        let k: String = row.get(0);
        let label: String = row.get(1);
        if k.contains(&query) {
            labels.push(label);
        }
        cursor = Some(k);
    }
    Ok(json!({"tag_choices":labels,"next_tag_cursor":if more {cursor} else {None}}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn trim_dedupe_case_insensitively_keep_first_spelling() {
        assert_eq!(
            normalize(Some(&json!([" Alpha Build ", "alpha build", "Progress"]))).unwrap(),
            vec!["Alpha Build", "Progress"]
        );
    }
    #[test]
    fn eight_tags_allowed_ninth_refused() {
        assert_eq!(
            normalize(Some(&json!(["a", "b", "c", "d", "e", "f", "g", "h"])))
                .unwrap()
                .len(),
            8
        );
        assert!(normalize(Some(&json!(["a", "b", "c", "d", "e", "f", "g", "h", "i"]))).is_err());
    }
    #[test]
    fn length_counts_characters_not_utf8_bytes_and_blank_refused() {
        assert!(normalize(Some(&json!(["\u{e9}".repeat(32)]))).is_ok());
        assert!(normalize(Some(&json!(["x".repeat(33)]))).is_err());
        assert!(normalize(Some(&json!(["   "]))).is_err());
    }
    #[test]
    fn shape_requires_strings_in_an_array() {
        for v in [json!("build"), json!([1]), json!({})] {
            assert!(normalize(Some(&v)).is_err());
        }
        assert!(normalize(None).unwrap().is_empty());
        assert!(normalize(Some(&json!([]))).unwrap().is_empty());
    }
    #[test]
    fn tagged_recipients_are_only_user_but_untagged_routes_unchanged() {
        let tags = vec!["alpha build".to_string()];
        assert!(recipient("user", &tags).is_ok());
        assert!(recipient(" @user ", &tags).is_ok());
        for to in ["peer", "@org:other", "@net:remote"] {
            let e = recipient(to, &tags)
                .expect_err("tagged non-user delivery must refuse before transport");
            assert!(e.to_string().contains("only for mail to the user"));
            assert!(recipient(to, &[]).is_ok());
        }
    }
    #[test]
    fn inbox_projection_carries_joined_labels_without_tagging_legacy_mail() {
        let old = json!({"uid":"old","sender":"lead","body":"old","kind":"message","created_at":"2026-10-17T00:00:00Z"});
        let mut tagged = old.clone();
        tagged["tags"] = json!(["Alpha Build"]);
        assert_eq!(
            crate::feed::compute::mail_entry(&tagged)["tags"],
            json!(["Alpha Build"])
        );
        assert!(crate::feed::compute::mail_entry(&old).get("tags").is_none());
    }
    #[test]
    fn filter_multiple_tags_keep_every_normalized_key() {
        assert_eq!(
            filter_keys(&[
                " Alpha Build ".into(),
                "Progress".into(),
                "alpha build".into()
            ])
            .unwrap(),
            vec!["alpha build", "progress"]
        );
    }
    #[test]
    fn filter_selection_is_not_limited_by_eight_tags_per_message() {
        let tags: Vec<String> = (0..20).map(|i| format!("tag{i}")).collect();
        assert_eq!(filter_keys(&tags).unwrap().len(), 20);
    }
    #[test]
    fn filter_rejects_invalid_later_selected_tags_too() {
        assert!(filter_keys(&["valid".into(), "".into()]).is_err());
        assert!(filter_keys(&["valid".into(), "x".repeat(33)]).is_err());
    }
    #[test]
    fn filter_empty_and_single_tag_controls() {
        assert!(filter_keys(&[]).unwrap().is_empty());
        assert_eq!(
            filter_keys(&[" Alpha Build ".into()]).unwrap(),
            vec!["alpha build"]
        );
    }
}
