//! Mailbox attention is not an urgent flag. All user-mail surfaces share it.
use serde_json::Value;
use anyhow::Result;

// Only user-visible prose, never sender/recipient identities, paths or ids.
const FIELDS: &[&str]=&["body","text","title","subject","gist","quoted_context","question","summary","excerpt","reason","err","headline"];
pub const DUPLICATE_MENTION_SQL: &str = "m.sender=a.name AND a.extra->'user_mention'->>'blurb' LIKE '%@user%' AND position(trim(both '…' from btrim(regexp_replace(a.extra->'user_mention'->>'blurb', '\\s+', ' ', 'g'))) in btrim(regexp_replace(m.body, '\\s+', ' ', 'g'))) > 0";
pub const SQL: &str = "(urgent OR concat_ws(E'\\n', body, (SELECT string_agg(part, E'\\n') FROM jsonb_array_elements_text(jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.body') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.text') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.title') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.subject') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.gist') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.quoted_context') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.question') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.summary') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.excerpt') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.reason') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.err') || jsonb_path_query_array(jsonb_build_array(ev,reply_to,replies), '$.**.headline')) AS prose(part))) ~ '(^|[^A-Za-z0-9_@./:-])@user([^A-Za-z0-9_-]|$)')";

#[nolog]
fn visible_mention(v:&Value)->bool {
    match v {
        Value::Array(a)=>a.iter().any(visible_mention),
        Value::Object(o)=>o.iter().any(|(k,v)| (FIELDS.contains(&k.as_str()) && v.as_str().is_some_and(|s|crate::runtime::convo::user_mention_blurb(s).is_some())) || (v.is_object() || v.is_array()) && visible_mention(v)),
        _=>false,
    }
}
#[nolog]
pub fn qualifies(mail:&Value)->bool {
    mail["urgent"]==true || crate::runtime::convo::user_mention_blurb(mail["body"].as_str().unwrap_or("")).is_some()
        || ["ev","reply_to","replies"].iter().any(|k|visible_mention(&mail[k]))
}

#[nolog]
pub fn covers_mention(mail:&Value, mention:&Value)->bool {
    let blurb=normalize(mention["blurb"].as_str().unwrap_or("")).trim_matches('…').to_string();
    !blurb.is_empty() && blurb.contains("@user") && normalize(mail["body"].as_str().unwrap_or("")).contains(&blurb)
}
#[nolog]
fn normalize(s:&str)->String {s.split_whitespace().collect::<Vec<_>>().join(" ")}

/// Clear only a matching sender's exact prose snapshot. A newer or unrelated
/// mention survives; transcript highlighting is independent of this marker.
#[logged]
pub async fn clear_read_mentions(client:&(impl tokio_postgres::GenericClient + Sync),org:i64,mails:&[Value])->Result<Vec<i64>> {
    let mut changed=Vec::new();
    for mail in mails {
        if !qualifies(mail) {continue;}
        let Some(id)=mail["sender_agent_id"].as_i64() else {continue;};
        let Some(row)=client.query_opt("SELECT extra->'user_mention' FROM ot.agents WHERE id=$1 AND org_id=$2 AND extra->'user_mention' IS NOT NULL",&[&id,&org]).await? else {continue;};
        let mention:Value=row.get(0);
        if !covers_mention(mail,&mention) {continue;}
        let n=client.execute("UPDATE ot.agents SET extra=extra-'user_mention',row_version=row_version+1 WHERE id=$1 AND extra->'user_mention'=$2",&[&id,&mention]).await?;
        if n>0 {changed.push(id);}
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn only_visible_standalone_mentions_qualify(){
        for s in ["@user", "Hello (@user).", "before\n@user: after"] {assert!(qualifies(&json!({"body":s})));}
        for s in ["email@user.com","@username","/@user/path","@user-name"] {assert!(!qualifies(&json!({"body":s})));}
        assert!(!qualifies(&json!({"body":"ordinary","ev":{"id":"@user","path":"@user"}})));
        assert!(qualifies(&json!({"urgent":true,"body":"plain"})));
    }
    #[test] fn sql_and_projection_cover_the_same_visible_fields(){
        for field in FIELDS {assert!(SQL.contains(&format!("$.**.{field}")));}
        assert!(SQL.contains("(^|[^A-Za-z0-9_@./:-])@user([^A-Za-z0-9_-]|$)"));
    }
    #[test] fn quote_arrays_qualify_without_metadata_matches(){
        assert!(qualifies(&json!({"replies":[{"gist":"See @user"}]})));
        assert!(!qualifies(&json!({"reply_to":{"node":"@user","id":"@user"}})));
    }
    #[test] fn a_read_mail_only_clears_the_matching_blurb(){
        let mail=json!({"body":"A complete reply for @user. More detail."});
        assert!(covers_mention(&mail,&json!({"blurb":"A complete reply for @user. More detail."})));
        assert!(!covers_mention(&mail,&json!({"blurb":"A different request for @user."})));
    }
}
