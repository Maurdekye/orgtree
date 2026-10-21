//! Mailbox attention is not an urgent flag. All user-mail surfaces share it.
use serde_json::Value;
use anyhow::Result;

// Only user-visible prose, never sender/recipient identities, paths or ids.
const FIELDS: &[&str]=&["body","text","title","subject","gist","quoted_context","question","summary","excerpt","reason","err","headline"];
// Same conservative 0..10 second window as the renderer and read-clear helper.
// CASE protects the cast: malformed legacy metadata leaves its mention visible.
pub const DUPLICATE_MENTION_SQL: &str = "m.sender=a.name AND CASE WHEN pg_input_is_valid(a.extra->'user_mention'->>'at', 'timestamp with time zone') THEN m.created_at >= (a.extra->'user_mention'->>'at')::timestamptz AND m.created_at <= (a.extra->'user_mention'->>'at')::timestamptz + interval '10 seconds' ELSE false END AND a.extra->'user_mention'->>'blurb' LIKE '%@user%' AND position(trim(both '…' from btrim(regexp_replace(a.extra->'user_mention'->>'blurb', '\\s+', ' ', 'g'))) in btrim(regexp_replace(m.body, '\\s+', ' ', 'g'))) > 0";
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
    let (Some(mail_at),Some(mention_at))=(mail["created_at"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()),
        mention["at"].as_str().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok())) else {return false;};
    if mail_at<mention_at || mail_at>mention_at+chrono::Duration::seconds(10) {return false;}
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
        let Some(sender)=mail["sender"].as_str() else {continue;};
        let Some(row)=client.query_opt("SELECT extra->'user_mention' FROM ot.agents WHERE id=$1 AND org_id=$2 AND name=$3 AND extra->'user_mention' IS NOT NULL",&[&id,&org,&sender]).await? else {continue;};
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
        let mail=json!({"body":"A complete reply for @user. More detail.","created_at":"2026-10-21T22:00:03Z"});
        assert!(covers_mention(&mail,&json!({"blurb":"A complete reply for @user. More detail.","at":"2026-10-21T22:00:00Z"})));
        assert!(!covers_mention(&mail,&json!({"blurb":"A different request for @user."})));
    }
    #[test] fn repeated_prose_only_covers_a_recent_prior_mention(){
        let mention=json!({"blurb":"Ready @user.","at":"2026-10-21T22:00:00Z"});
        for at in ["2026-10-20T10:00:00Z","2026-10-21T22:00:10.001Z","", "invalid"] {
            assert!(!covers_mention(&json!({"body":"Ready @user.","created_at":at}),&mention),"{at}");
        }
        for at in ["2026-10-21T22:00:00Z","2026-10-21T22:00:03Z","2026-10-22T01:00:10+03:00"] {
            assert!(covers_mention(&json!({"body":"Ready @user.","created_at":at}),&mention),"{at}");
        }
    }
    #[tokio::test]
    #[ignore="requires explicit isolated mail_attention_fixture cluster"]
    async fn postgres_attention_counts_match_visible_prose_beyond_one_page(){
        let (client,connection)=fixture().await;
        let cases=[
            json!({"body":"Do not alert on `@user` in code."}),
            json!({"body":"```ts\nconst x='@user'\n```"}),
            json!({"body":"~~~\n@user\n~~~"}),
            json!({"body":"Before\n\n    @user in code\n"}),
            json!({"body":"<CODE>@user</CODE>"}),
            json!({"body":"plain","replies":[{"gist":"quoted `@user` only"}]}),
            json!({"body":"plain","ev":{"quote":{"subject":"~~~\n@user\n~~~"}}}),
            json!({"body":"Skip `@user`, but alert @USER outside."}),
            json!({"body":"plain","replies":[{"gist":"Please review @user."}]}),
            json!({"body":"plain","urgent":true}),
            json!({"body":"email@user.com @username %@user +@user @user/path @user.txt"}),
            json!({"body":"`@user` only","ev":{"quote":{"gist":"Real @user outside code"}}}),
        ];
        let mut mismatches=Vec::new();
        for (i,mail) in cases.iter().enumerate(){
            client.execute("DELETE FROM ot.mail",&[]).await.unwrap();
            client.execute("INSERT INTO ot.mail(id,body,urgent,ev,reply_to,replies) VALUES(1,$1,$2,$3,$4,$5)",
                &[&mail["body"].as_str().unwrap(),&mail["urgent"].as_bool().unwrap_or(false),&mail["ev"],&mail["reply_to"],&mail["replies"]]).await.unwrap();
            let count=crate::domain::notices::attention_count(&client,1).await.unwrap();
            if count!=i64::from(qualifies(mail)){mismatches.push((i,count,qualifies(mail)));}
        }
        assert!(mismatches.is_empty(),"SQL/native count differs from projection: {mismatches:?}");
        client.batch_execute("DELETE FROM ot.mail; INSERT INTO ot.mail(id,body) SELECT i,'Ready @user.' FROM generate_series(1,405) i;
            INSERT INTO ot.mail(id,body,state) SELECT i,'Old @user.','read' FROM generate_series(406,810) i;").await.unwrap();
        assert_eq!(crate::domain::notices::attention_count(&client,1).await.unwrap(),405,"count must exhaust pending pages and ignore read history");
        drop(client);connection.await.unwrap();
    }
    #[tokio::test]
    #[ignore="requires explicit isolated mail_attention_fixture cluster"]
    async fn postgres_duplicate_guard_matches_read_clear_window(){
        let (client,connection)=fixture().await;
        client.batch_execute("INSERT INTO ot.agents(id,org_id,name,state,extra) VALUES(7,1,'worker','live','{\"user_mention\":{\"id\":\"fresh\",\"blurb\":\"Ready @user.\",\"at\":\"2026-10-21T22:00:00Z\"}}');
            INSERT INTO ot.mail(id,sender,sender_agent_id,body) VALUES(1,'worker',7,'Ready @user.');").await.unwrap();
        let mut mismatches=Vec::new();
        for (at,expected) in [("2026-10-20T10:00:00Z",false),("2026-10-21T22:00:00Z",true),("2026-10-21T22:00:03Z",true),("2026-10-21T22:00:10Z",true),("2026-10-21T22:00:10.001Z",false)] {
            client.execute("UPDATE ot.mail SET created_at=$1::text::timestamptz",&[&at]).await.unwrap();
            let query=format!("SELECT coalesce(({DUPLICATE_MENTION_SQL}),false) FROM ot.mail m CROSS JOIN ot.agents a");
            let actual:bool=client.query_one(&query,&[]).await.unwrap().get(0);
            if actual!=expected{mismatches.push((at,actual,expected));}
        }
        assert!(mismatches.is_empty(),"stale/future mail suppresses mention: {mismatches:?}");
        client.batch_execute("UPDATE ot.mail SET created_at='2026-10-20T10:00:00Z'").await.unwrap();
        let raw:Value=client.query_one("SELECT to_jsonb(m) FROM ot.mail m",&[]).await.unwrap().get(0);
        assert!(clear_read_mentions(&client,1,&[raw]).await.unwrap().is_empty());
        client.batch_execute("UPDATE ot.mail SET created_at='2026-10-21T22:00:03Z'").await.unwrap();
        let raw:Value=client.query_one("SELECT to_jsonb(m) FROM ot.mail m",&[]).await.unwrap().get(0);
        assert_eq!(clear_read_mentions(&client,1,&[raw]).await.unwrap(),vec![7]);
        drop(client);connection.await.unwrap();
    }
    #[nolog]
    async fn fixture()->(tokio_postgres::Client,tokio::task::JoinHandle<()>){
        let url=std::env::var("ORGTREE_MAIL_ATTENTION_TEST_URL").expect("explicit synthetic fixture URL");
        let cfg:tokio_postgres::Config=url.parse().unwrap();
        assert_eq!(cfg.get_dbname(),Some("mail_attention_fixture"));
        assert_eq!(cfg.get_user(),Some("mail_attention_fixture"));
        let (client,connection)=cfg.connect(tokio_postgres::NoTls).await.unwrap();
        let connection=tokio::spawn(async move{connection.await.unwrap();});
        client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; CREATE SCHEMA ot;
            CREATE TABLE ot.orgs(id bigint PRIMARY KEY,settings jsonb); INSERT INTO ot.orgs VALUES(1,'{}');
            CREATE TABLE ot.agents(id bigint,org_id bigint,name text,generation int,state text,extra jsonb,row_version bigint DEFAULT 0);
            CREATE TABLE ot.asks(org_id bigint,agent_id bigint,status text); CREATE TABLE ot.work_items(org_id bigint,manual_attention jsonb);
            CREATE TABLE ot.mail(id bigint PRIMARY KEY,org_id bigint DEFAULT 1,sender text DEFAULT 'worker',sender_agent_id bigint,recipient_kind text DEFAULT 'user',
                state text DEFAULT 'pending',body text DEFAULT '',urgent bool DEFAULT false,ev jsonb,reply_to jsonb,replies jsonb,extra jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());").await.unwrap();
        (client,connection)
    }
    #[test] fn code_spans_and_fenced_blocks_do_not_qualify_mail_mentions(){
        assert!(!qualifies(&json!({"body":"Do not alert on `@user` in code."})));
        assert!(!qualifies(&json!({"body":"```\n@user\n```"})));
        assert!(qualifies(&json!({"body":"Ignore `@user` in code, but alert @user here."})));
    }
}
