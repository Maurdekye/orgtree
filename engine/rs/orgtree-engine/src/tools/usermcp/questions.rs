//! User question discovery and decisions. Never log native form content.
use super::*;
use axum::{extract::{Path, State}, Json};

#[nolog]
pub(super) fn card() -> Value {
    user_card("orgtree_questions",
        "Discover and resolve this org's pending user requests. list (default): limit 1-200/default50, cursor from next_cursor; open question/credit/scope/batch/native elicitation cards only. get needs id. credit needs id and decision approve|deny, optional granted total, rev and dry preview. batch needs node plus the card's revs and explicit answers/credits/scope decisions, using the desktop's whole-request submit. Pagination is a live view; reread amended cards before deciding. Ordinary answers use orgtree_answer.",
        json!({"action":{"type":"string","enum":["list","get","credit","batch"]},
            "limit":{"type":"integer","minimum":1,"maximum":200},"cursor":{"type":"string"},
            "id":{"type":"string"},"decision":{"type":"string","enum":["approve","deny"]},
            "granted":{"type":"number"},"rev":{"type":"integer"},"dry":{"type":"boolean"},
            "node":{"type":"string"},"revs":{"type":"object","properties":{"ask":{"type":"integer"},"credits":{"type":"integer"},"scope":{"type":"integer"}},"additionalProperties":false},
            "answers":{"type":"array","items":{"anyOf":[{"type":"object"},{"type":"null"}]}},
            "credits":{"type":"object","properties":{"granted":{"type":"number"},"deny":{"type":"boolean"},"skip":{"type":"boolean"}},"additionalProperties":false},
            "scope":{"type":"array","items":{"type":"string","enum":["approve","deny","skip"]}}}), &[])
}

#[nolog]
pub(super) fn only(args: &Value, fields: &[&str]) -> Result<()> {
    if !args.as_object().is_some_and(|a| a.keys().all(|k| fields.contains(&k.as_str()))) {
        crate::refuse!(BadRequest,"unexpected field for this user MCP action");
    }
    Ok(())
}

#[nolog]
pub(super) async fn run(engine: &Arc<Engine>, org: &Arc<OrgHandle>, args: &Value) -> Result<Done> {
    let value = match args["action"].as_str().unwrap_or("list") {
        "list" => {
            only(args, &["action","limit","cursor"])?;
            let limit = match args.get("limit") {
                None => 50,
                Some(v) => v.as_u64().filter(|n| (1..=200).contains(n)).ok_or_else(|| anyhow::anyhow!("limit must be 1-200"))? as usize,
            };
            let after = match args.get("cursor") {
                None => "",
                Some(v) => v.as_str().filter(|s| s.len()<=256).ok_or_else(||anyhow::anyhow!("invalid question cursor"))?,
            };
            let client = engine.db.get().await?;
            let count = (limit + 1) as i64;
            let rows = client.query("SELECT to_jsonb(k), a.name FROM ot.asks k JOIN ot.agents a ON a.id=k.agent_id WHERE k.org_id=$1 AND k.status='open' AND k.uid > $2 ORDER BY k.uid LIMIT $3", &[&org.id, &after, &count]).await?;
            let mut cards: Vec<Value> = rows.into_iter().map(|r| crate::domain::tree::ask_card(&r.get::<_,Value>(0), &r.get::<_,String>(1))).collect();
            cards.extend(engine.elicitations.cards(org.id).into_iter().filter(|c| c["id"].as_str().is_some_and(|id| id>after)));
            page(cards,limit)
        }
        "get" => {
            only(args, &["action","id"])?;
            let id = need_str(args,"id")?;
            if let Some(card) = engine.elicitations.cards(org.id).into_iter().find(|c| c["id"]==id) { card }
            else {
                let client=engine.db.get().await?;
                let row=client.query_opt("SELECT to_jsonb(k), a.name FROM ot.asks k JOIN ot.agents a ON a.id=k.agent_id WHERE k.org_id=$1 AND k.uid=$2 AND k.status='open'", &[&org.id,&id]).await?;
                let Some(row)=row else { crate::refuse!(NotFound,"no open request with that id in this organization"); };
                crate::domain::tree::ask_card(&row.get::<_,Value>(0), &row.get::<_,String>(1))
            }
        }
        "credit" => {
            only(args, &["action","id","decision","granted","rev","dry"])?;
            let id=need_str(args,"id")?;
            let decision=need_str(args,"decision")?;
            if !["approve","deny"].contains(&decision) { crate::refuse!(BadRequest,"decision must be approve or deny"); }
            let mut body=json!({"id":id,"action":decision});
            for key in ["granted","rev","dry"] { if let Some(v)=args.get(key) { body[key]=v.clone(); } }
            crate::http::asks::credit(State(engine.clone()),Path(org.slug.clone()),Json(body)).await.map_err(api)?.0
        }
        "batch" => {
            only(args, &["action","node","revs","answers","credits","scope"])?;
            let node=need_str(args,"node")?;
            for key in ["revs","credits"] {
                if let Some(v)=args.get(key) { only(v, if key=="revs" { &["ask","credits","scope"] } else { &["granted","deny","skip"] })?; }
            }
            let mut body=json!({});
            for key in ["revs","answers","credits","scope"] { if let Some(v)=args.get(key) { body[key]=v.clone(); } }
            crate::http::asks::batch(State(engine.clone()),Path((org.slug.clone(),node.to_string())),Json(body)).await.map_err(api)?.0
        }
        _ => crate::refuse!(BadRequest,"unsupported user question action"),
    };
    Ok(Done{text:serde_json::to_string(&value)?,card:None})
}

#[nolog]
fn page(mut cards: Vec<Value>, limit: usize) -> Value {
    cards.sort_by(|a,b| a["id"].as_str().cmp(&b["id"].as_str()));
    let more=cards.len()>limit;
    cards.truncate(limit);
    let next=if more { cards.last().map(|c|c["id"].clone()).unwrap_or(Value::Null) } else { Value::Null };
    json!({"questions":cards,"next_cursor":next})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pending_pages_merge_native_cards_and_bound_the_response() {
        let page=page(vec![json!({"id":"q2"}),json!({"id":"q1"}),json!({"id":"elicitation-a"})],2);
        assert_eq!(page["questions"],json!([{"id":"elicitation-a"},{"id":"q1"}]));
        assert_eq!(page["next_cursor"],"q1");
        assert_eq!(super::page(vec![],50)["next_cursor"],Value::Null);
        assert!(only(&json!({"granted":2,"op":"hire"}),&["granted","deny","skip"]).is_err());
    }

    #[tokio::test]
    async fn native_answer_is_user_correlated_without_echo_or_verbose_log_leak() {
        let capture=crate::trace::LogCapture::start().await;
        tracing::info!("user MCP private form positive log control");
        let engine=Engine::for_tests(std::env::temp_dir().join(format!("orgtree-usermcp-{}",uuid::Uuid::new_v4())));
        let org=crate::orgs::provisional(1,"synthetic-uuid".into(),"synthetic".into(),"Synthetic".into());
        engine.orgs.insert(org.clone());
        let caller=crate::runtime::Caller{org_id:1,org_slug:org.slug.clone(),agent_id:7,name:"fixture".into()};
        let form=json!({"serverName":"synthetic","threadId":"thread","message":"Synthetic form",
            "requestedSchema":{"type":"object","properties":{"note":{"type":"string"}},"required":["note"]}});
        let stop=tokio_util::sync::CancellationToken::new();
        let mut pending=Box::pin(crate::runtime::elicitation::native_request(&engine,&caller,&form,&stop));
        assert!(futures_util::poll!(&mut pending).is_pending());
        let id=engine.elicitations.cards(org.id)[0]["id"].as_str().unwrap().to_string();
        let get=super::super::handle(&engine,Some(&org),&json!({"id":1,"method":"tools/call","params":{"name":"orgtree_questions","arguments":{"action":"get","id":id}}})).await;
        assert_ne!(get["result"]["isError"],true);
        let wrong=crate::orgs::provisional(2,"other-uuid".into(),"other".into(),"Other".into());
        engine.orgs.insert(wrong.clone());
        let secret="SYNTHETIC_PRIVATE_FORM_CANARY_85a1";
        let msg=json!({"id":2,"method":"tools/call","params":{"name":"orgtree_answer","arguments":{"ask":id,"action":"accept","content":{"note":secret}}}});
        let refused=super::super::handle(&engine,Some(&wrong),&msg).await;
        assert_eq!(refused["result"]["isError"],true);
        let accepted=super::super::handle(&engine,Some(&org),&msg).await;
        assert_ne!(accepted["result"]["isError"],true);
        assert!(!accepted.to_string().contains(secret));
        assert_eq!(pending.await["content"]["note"],secret);
        assert_eq!(super::super::handle(&engine,Some(&org),&msg).await["result"]["isError"],true);
        let log=capture.finish().await;
        assert!(log.contains("user MCP private form positive log control"));
        assert!(!log.contains(secret),"private submission leaked to verbose log");
    }
}
