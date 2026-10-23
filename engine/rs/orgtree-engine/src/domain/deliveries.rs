//! Retained download cards. The delivery snapshot and identity stay send_file-owned.
use anyhow::Result;
use serde_json::{json, Value};
use tokio_postgres::GenericClient;

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub node: Option<String>,
    pub limit: Option<i64>,
    pub before: Option<String>,
}

#[logged]
impl Page {
    pub fn bounds(&self) -> Result<(i64, Option<i64>)> {
        let limit = self.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) { crate::refuse!(BadRequest, "limit must be an integer from 1 to 100"); }
        let before = match &self.before {
            None => None,
            Some(s) => match s.parse::<i64>().ok().filter(|n| *n > 0) {
                Some(n) => Some(n),
                None => crate::refuse!(BadRequest, "before must be a returned file cursor"),
            },
        };
        Ok((limit, before))
    }
}

/// Keyset paging uses deliveries_agent; never read a transcript or scan inactive history.
#[logged]
pub async fn list<C: GenericClient + Sync>(client: &C, org_id: i64, agent_id: i64, node: &str, page: &Page) -> Result<Value> {
    let (limit, before) = page.bounds()?;
    let rows = client.query(
        "SELECT id, uid, name, path, bytes, note, at FROM ot.deliveries
         WHERE org_id=$1 AND agent_id=$2 AND ($3::bigint IS NULL OR id < $3)
         ORDER BY id DESC LIMIT $4", &[&org_id, &agent_id, &before, &(limit + 1)]).await?;
    let more = rows.len() > limit as usize;
    let files: Vec<Value> = rows.iter().take(limit as usize).map(|r| json!({
        "delivery_id":r.get::<_,String>(1), "name":r.get::<_,String>(2), "path":r.get::<_,String>(3),
        "bytes":r.get::<_,i64>(4), "note":r.get::<_,Option<String>>(5), "at":crate::util::iso(r.get(6))
    })).collect();
    let next = if more { rows.get(limit as usize - 1).map(|r| r.get::<_,i64>(0).to_string()) } else { None };
    Ok(json!({"node":node,"files":files,"next_cursor":next}))
}

#[cfg(test)]
mod files_tab_tests {
    use super::*;
    #[test]
    fn paging_refuses_unbounded_and_malformed_requests() {
        for value in [json!({"limit":0}),json!({"limit":101}),json!({"before":"0"}),json!({"before":"-1"}),json!({"before":"not-a-cursor"})] {
            assert!(serde_json::from_value::<Page>(value).unwrap().bounds().is_err());
        }
        for value in [json!({"limit":1.5}),json!({"limit":"50"}),json!({"before":12}),json!({"path":"guessed"})] {
            assert!(serde_json::from_value::<Page>(value).is_err());
        }
        assert_eq!(serde_json::from_value::<Page>(json!({})).unwrap().bounds().unwrap(),(50,None));
        assert_eq!(serde_json::from_value::<Page>(json!({"limit":100,"before":"9223372036854775807"})).unwrap().bounds().unwrap(),(100,Some(i64::MAX)));
    }

    #[tokio::test]
    #[ignore = "requires the explicitly owned disposable native fixture"]
    async fn retained_rows_page_without_cross_org_or_cross_agent_leaks() {
        let fixture = crate::domain::native_fixture::Fixture::from_env().await;
        let (mut client, connection) = fixture.cfg.connect(tokio_postgres::NoTls).await.unwrap();
        let connection = tokio::spawn(async move { connection.await.unwrap() });
        crate::migrate::run(&mut client, &|_| {}).await.unwrap();
        let tx = client.transaction().await.unwrap();
        let org: i64 = tx.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES($1,$2,'Synthetic files') RETURNING id",
            &[&uuid::Uuid::new_v4(), &format!("files-{}",uuid::Uuid::new_v4())]).await.unwrap().get(0);
        let other_org: i64 = tx.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES($1,$2,'Other files') RETURNING id",
            &[&uuid::Uuid::new_v4(), &format!("files-{}",uuid::Uuid::new_v4())]).await.unwrap().get(0);
        let owner: i64 = tx.query_one("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,'maker','sol','live','synthetic') RETURNING id",&[&org]).await.unwrap().get(0);
        let sibling: i64 = tx.query_one("INSERT INTO ot.agents(org_id,name,tier,state,born) VALUES($1,'sibling','sol','live','synthetic') RETURNING id",&[&org]).await.unwrap().get(0);
        for (id,agent) in [("old",owner),("middle",owner),("new",owner),("secret",sibling)] {
            tx.execute("INSERT INTO ot.deliveries(uid,org_id,agent_id,name,path,bytes,note,at) VALUES($1,$2,$3,$1,'/snapshot/'||$1,42,'original note','2020-01-01')",&[&id,&org,&agent]).await.unwrap();
        }
        let first = list(&tx,org,owner,"maker",&Page{node:None,limit:Some(2),before:None}).await.unwrap();
        assert_eq!(first["files"].as_array().unwrap().iter().map(|r|r["name"].as_str().unwrap()).collect::<Vec<_>>(),vec!["new","middle"]);
        assert_eq!(first["files"][0]["note"],"original note");
        assert_eq!(first["files"][0]["path"],"/snapshot/new");
        let before = first["next_cursor"].as_str().unwrap().to_string();
        tx.execute("INSERT INTO ot.deliveries(uid,org_id,agent_id,name,path,bytes) VALUES('arrived',$1,$2,'arrived','/snapshot/arrived',43)",&[&org,&owner]).await.unwrap();
        tx.execute("UPDATE ot.agents SET name='renamed',state='archived' WHERE id=$1",&[&owner]).await.unwrap();
        let page = Page{node:None,limit:Some(2),before:Some(before)};
        let old = list(&tx,org,owner,"renamed",&page).await.unwrap();
        assert_eq!(old["files"].as_array().unwrap().len(),1);
        assert_eq!(old["files"][0]["name"],"old");
        assert!(old["next_cursor"].is_null());
        let wrong_org = list(&tx,other_org,owner,"renamed",&Page{node:None,limit:None,before:None}).await.unwrap();
        assert!(wrong_org["files"].as_array().unwrap().is_empty());
        tx.rollback().await.unwrap();drop(client);connection.await.unwrap();
    }
}
