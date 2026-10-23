//! Exact, side-effect-free source reads shared by selection replies and UI.
//! One indexed object/row is read. No history scans, provider files or receipts
//! are consumed, and no read creates a permission to the rest of a source.
use anyhow::Result;
use serde_json::{json, Value};
use crate::{engine::Engine, orgs::OrgHandle};
use super::{selections::{self, Part, Selector}, UserError};

pub enum Reader<'a> {
    User,
    Agent { id: i64, name: &'a str, inspection: bool },
}

pub struct Source {
    pub text: String,
    pub revision: Value,
    pub quote: Value,
}

#[nolog]
impl Source {
    pub fn capture(&self, selector: &Selector) -> Result<Value> {
        let mut quote = self.quote.clone();
        quote["selection"] = selections::capture(&self.text, selector, &self.revision)?;
        quote["quoted_context"] = quote["selection"]["excerpt"].clone();
        quote["gist"] = quote["selection"]["excerpt"].clone();
        Ok(quote)
    }
}

#[nolog]
fn missing() -> anyhow::Error { super::user_err(UserError::NotFound, "Source unavailable or that source part was not retained") }

#[nolog]
fn text(value: &Value) -> Result<String> {
    value.as_str().map(str::to_owned).ok_or_else(missing)
}

/// Canonical JSON projection uses decoded scalar strings; objects/arrays use
/// deterministic pretty JSON. A key is a distinct part from its value.
#[nolog]
pub fn input_part(input: &Value, part: &Part) -> Result<String> {
    let pointer = part.pointer.as_deref().unwrap_or("");
    let value = input.pointer(pointer).ok_or_else(missing)?;
    if part.role.as_deref() == Some("key") {
        let (parent, key) = pointer.rsplit_once('/').ok_or_else(missing)?;
        let key = key.replace("~1", "/").replace("~0", "~");
        if !input.pointer(parent).and_then(Value::as_object).is_some_and(|o| o.contains_key(&key)) { return Err(missing()); }
        return Ok(key);
    }
    Ok(match value.as_str() { Some(s) => s.to_owned(), None => serde_json::to_string_pretty(value)? })
}

/// Restrict visible transcript parts. Machine segments, sealed reasoning,
/// summaries and reconstructed JSON closers are never source text.
#[nolog]
pub fn event_part(body: &Value, inputs: &Value, native: &Value, part: &Part, agent: &str, mail: Option<&str>) -> Result<String> {
    match part.part.as_str() {
        "mail.body" if mail.is_some() => Ok(super::replies::event_context(body, agent, mail)?.1),
        "text" if body["role"] == "user" => Ok(super::replies::event_context(body, agent, None)?.1),
        "thinking" if body["thinking_sealed"] == true => Err(missing()),
        "text" | "thinking" | "cmd_out" => text(&body[&part.part]),
        "tool.input" | "tool.result" | "tool.error" => {
            let id = part.tool_id.as_deref().ok_or_else(missing)?;
            let chip = body["tools"].as_array().into_iter().flatten().find(|c| c["id"].as_str() == Some(id)).ok_or_else(missing)?;
            if part.part == "tool.input" {
                let raw = native.get(id).or_else(|| inputs.get(id).and_then(|v| v.get("input")))
                    .or_else(|| chip.get("input")).ok_or_else(missing)?;
                let name = chip["name"].as_str().unwrap_or("");
                let mut input = crate::runtime::convo::unwrap_stored_tool_input(Some(name), raw);
                crate::runtime::convo::redact_tool_input(name, &mut input);
                input_part(&input, part)
            } else {
                let key = if part.part == "tool.result" { "result" } else { "error" };
                let retained = if part.part == "tool.result" { inputs.get(id).and_then(|v|v.get("failed_shell_output")) } else { None };
                let decoded = retained.and_then(|v|v.get("output_base64")).and_then(Value::as_str).and_then(|encoded| {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD.decode(encoded).ok().and_then(|bytes|String::from_utf8(bytes).ok()).map(Value::String)
                });
                let value = decoded.as_ref().or_else(||retained.and_then(|v|v.get("output"))).or_else(||chip.get(key)).ok_or_else(missing)?;
                if part.pointer.is_some() || part.role.is_some() {
                    let parsed = if let Some(raw)=value.as_str() { serde_json::from_str(raw).map_err(|_|missing())? } else { value.clone() };
                    return input_part(&parsed,part);
                }
                Ok(match value.as_str() { Some(s) => s.to_owned(), None => serde_json::to_string_pretty(value)? })
            }
        }
        _ => Err(missing()),
    }
}

/// Lists have no durable element IDs. Refuse duplicate source entries and
/// keep navigation confined to the captured field/index rather than guessing.
#[nolog]
pub fn docket_part(item: &Value, part: &Part) -> Result<String> {
    let field = part.part.strip_prefix("work_item.").ok_or_else(missing)?;
    if let Some(index) = part.entry {
        let field = if field == "evidence.note" { "evidence" } else { field };
        let entries = item[field].as_array().ok_or_else(missing)?;
        let value = entries.get(index).ok_or_else(missing)?;
        let selected = if field == "evidence" { text(&value["note"])? } else { text(value)? };
        let duplicates = entries.iter().filter(|v| {
            (if field == "evidence" { v["note"].as_str() } else { v.as_str() }) == Some(selected.as_str())
        }).count();
        if duplicates != 1 { crate::refuse!(Conflict, "this list has duplicate entries without stable identities; select a unique field instead"); }
        Ok(selected)
    } else {
        text(&item[field])
    }
}

/// A wrapper's identity is still checked by the ordinary reply parser. There
/// is no recursion and no caller-supplied quote prose in the accepted shape.
#[nolog]
pub fn wrapper(value: &Value) -> Result<Option<(&Value, Selector)>> {
    if value.get("selection").is_none() && value.get("target").is_none() { return Ok(None); }
    let Some(object) = value.as_object().filter(|o| o.len() == 2 && o.contains_key("target") && o.contains_key("selection")) else {
        crate::refuse!(BadRequest, "selection replies need only target and selection");
    };
    let target = &object["target"];
    if target.get("selection").is_some() || target.get("target").is_some() {
        crate::refuse!(BadRequest, "selection wrappers cannot be nested");
    }
    super::replies::targets(Some(target), None)?;
    Ok(Some((target, Selector::parse(&object["selection"])?)))
}

/// Source identities are org-local. Agent reads use ordinary mail custody,
/// transcript self/downward + inspection, docket ACL or project reach. An
/// agent may read its own authored presentation, including a project copy.
#[nolog]
pub async fn load(engine: &Engine, org: &OrgHandle, reader: &Reader<'_>, target: &Value, part: &Part) -> Result<Source> {
    part.validate()?;
    if target["org"].as_str().is_some_and(|s| s != org.slug) { crate::refuse!(BadRequest, "source belongs to another organization"); }
    if let Some(event) = target.get("source_event_ref") {
        if event["org"].as_str() != Some(org.slug.as_str()) { crate::refuse!(BadRequest, "source belongs to another organization"); }
        let name = event["agent"].as_str().ok_or_else(missing)?;
        let generation = event["generation"].as_i64().and_then(|n| i32::try_from(n).ok()).filter(|n| *n > 0).ok_or_else(missing)?;
        if let Some(id) = event["eventId"].as_str().and_then(|s| s.strip_prefix("mail:")) {
            if target["mail_id"].as_str() != Some(id) || part.part != "mail.body" { return Err(missing()); }
            let source = mail(engine, org, reader, id, Some((name, generation))).await?;
            return Ok(Source { quote: json!({"source_event_ref":event,"mail_id":id,"sender":source.quote["from"]}), ..source });
        }
        let seq = event["eventId"].as_str().and_then(|s| s.strip_prefix('e')).and_then(|s| s.parse::<i64>().ok()).filter(|s| *s > 0).ok_or_else(missing)?;
        let client = engine.db.get().await?;
        let row = client.query_opt("SELECT c.body,c.tool_inputs,c.tool_native_inputs,c.ver,a.id, c.at >= a.inflight_at FROM ot.convo c JOIN ot.agents a ON a.id=c.agent_id WHERE a.org_id=$1 AND a.name=$2 AND a.generation=$3 AND c.seq=$4 AND a.state<>'deleted'", &[&org.id,&name,&generation,&seq]).await?.ok_or_else(missing)?;
        if let Reader::Agent { id, inspection, .. } = reader {
            if !inspection || *id != row.get::<_,i64>(4) && !crate::tools::is_descendant(&client,*id,row.get(4)).await? {
                crate::refuse!(Forbidden, "exact transcript sources require inspection and self/downward authority");
            }
        }
        if row.get::<_,Option<bool>>(5) == Some(true) { crate::refuse!(Conflict, "this transcript turn is still running; select settled text after the turn finishes"); }
        let body: Value = row.get(0);
        let text = event_part(&body, &row.get::<_,Value>(1), &row.get::<_,Value>(2), part, name, target["mail_id"].as_str())?;
        let mut quote = json!({"source_event_ref":event,"sender":if body["role"]=="user" {"@user"} else {name},"source_agent_id":row.get::<_,i64>(4)});
        if let Some(id) = target["mail_id"].as_str() { quote["mail_id"] = json!(id); }
        return bounded(Source { text, revision: json!(row.get::<_,i64>(3)), quote });
    }
    let kind = target["kind"].as_str().unwrap_or(if target.is_string() { "mail" } else { "" });
    let id = target.as_str().or_else(|| target["id"].as_str()).unwrap_or("");
    match kind {
        "mail" if part.part == "mail.body" => mail(engine, org, reader, id, None).await,
        "document" | "presentation" if matches!(part.part.as_str(),"document.body"|"document.title") => {
            let client = engine.db.get().await?;
            let row = client.query_opt("SELECT d.uid,d.agent_id,coalesce(a.name,d.node_name),d.title,d.body,d.format,d.at,coalesce(d.presented_by,'') FROM ot.documents d LEFT JOIN ot.agents a ON a.id=d.agent_id WHERE d.org_id=$1 AND d.uid=$2", &[&org.id,&id]).await?.ok_or_else(missing)?;
            if row.get::<_,String>(5) != "markdown" { crate::refuse!(BadRequest, "interactive HTML presentations do not support text selection replies"); }
            if let Reader::Agent { id: agent, name, .. } = reader {
                if row.get::<_,Option<i64>>(1) != Some(*agent) && row.get::<_,String>(7) != *name {
                    let project = super::projects::by_name(&**client,org.id,&row.get::<_,String>(2)).await?.ok_or_else(|| super::user_err(UserError::Forbidden,"only authored or reachable project presentations are readable"))?;
                    super::projects::require_reach(&**client,*agent,&project,"read its presentation source").await?;
                }
            }
            let text = if part.part == "document.title" { row.get(3) } else { row.get::<_,Option<String>>(4).ok_or_else(missing)? };
            bounded(Source { text, revision: json!(crate::util::iso(row.get(6))),
                quote: json!({"kind":"document","org":org.slug,"id":id,"from":row.get::<_,String>(2),"title":row.get::<_,String>(3),"at":crate::util::iso(row.get(6))}) })
        }
        "work_item" if part.part.starts_with("work_item.") => {
            let slug = target["slug"].as_str().or_else(|| target["id"].as_str()).ok_or_else(missing)?;
            let client=engine.db.get().await?;
            if let Reader::Agent { id,name,.. }=reader {
                if !super::docket::event_readable(&**client,*id,name,org.id,slug).await? {
                    crate::refuse!(Forbidden,"that docket source is not readable under the ordinary item ACL");
                }
            }
            let row=client.query_opt("SELECT title,objective,rev,blocked_reason,dropped_reason,done_so_far,working_on_next,evidence,updated_at FROM ot.work_items WHERE org_id=$1 AND slug=$2 AND NOT coalesce((extra->>'deleted')::boolean,false)", &[&org.id,&slug]).await?.ok_or_else(missing)?;
            let item=json!({"title":row.get::<_,String>(0),"objective":row.get::<_,String>(1),"rev":row.get::<_,i64>(2),
                "blocked_reason":row.get::<_,Option<String>>(3),"dropped_reason":row.get::<_,Option<String>>(4),
                "done_so_far":row.get::<_,Value>(5),"working_on_next":row.get::<_,Value>(6),"evidence":row.get::<_,Value>(7),"updated_at":crate::util::iso(row.get(8))});
            bounded(Source { text: docket_part(&item,part)?, revision:item["rev"].clone(),
                quote: json!({"kind":"work_item","org":org.slug,"id":slug,"from":"docket","title":item["title"],"at":item["updated_at"]}) })
        }
        _ => crate::refuse!(BadRequest, "source part does not belong to that reply target"),
    }
}

#[nolog]
fn bounded(source: Source) -> Result<Source> {
    if source.text.len() > 1024 * 1024 { crate::refuse!(BadRequest, "source part exceeds 1 MiB; select a smaller retained field or JSON scalar"); }
    Ok(source)
}

#[nolog]
async fn mail(engine: &Engine, org: &OrgHandle, reader: &Reader<'_>, id: &str, desk: Option<(&str,i32)>) -> Result<Source> {
    let id = id.trim().trim_start_matches("@mail:");
    let client = engine.db.get().await?;
    let agent = match reader { Reader::User => None, Reader::Agent {id,..} if desk.is_none() => Some(*id), _ => None };
    let row = client.query_opt("SELECT m.sender,m.body,m.created_at,m.recipient_kind,m.recipient_name,m.recipient_agent_id,a.name,a.generation FROM ot.mail m LEFT JOIN ot.agents a ON a.id=m.recipient_agent_id WHERE m.org_id=$1 AND m.uid=$2 AND ($3::bigint IS NULL OR m.recipient_agent_id=$3 OR m.sender_agent_id=$3) AND ((m.sender NOT LIKE '@org:%' AND m.sender NOT LIKE '@net:%' AND coalesce(m.ev->>'variant','')<>'runtime.external_unroutable' AND m.extra->>'transfer_failure' IS NULL) OR NOT EXISTS(SELECT 1 FROM ot.orgs o WHERE o.id=m.org_id AND o.settings->'org_inbox_enabled'='false'::jsonb))", &[&org.id,&id,&agent]).await?.ok_or_else(missing)?;
    if let Some((name,generation)) = desk {
        if row.get::<_,Option<String>>(6).as_deref()!=Some(name) || row.get::<_,Option<i32>>(7)!=Some(generation) { return Err(missing()); }
        if let Reader::Agent { id, inspection, .. } = reader {
            let recipient: i64 = row.get::<_,Option<i64>>(5).ok_or_else(missing)?;
            if !inspection || *id != recipient && !crate::tools::is_descendant(&client,*id,recipient).await? {
                crate::refuse!(Forbidden, "exact transcript sources require inspection and self/downward authority");
            }
        }
    }
    bounded(Source { text:row.get(1), revision:json!(selections::digest(&row.get::<_,String>(1))),
        quote:json!({"kind":"mail","org":org.slug,"id":id,"from":row.get::<_,String>(0),"at":crate::util::iso(row.get(2)),
            "box":if row.get::<_,String>(3)=="user" {"user"} else {"node"},"node":row.get::<_,String>(4)}) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reply_selection_source_never_uses_machine_envelope_or_unknown_parts() {
        let body=json!({"role":"user","text":"HIDDEN","segments":[{"kind":"state","text":"HIDDEN"},{"kind":"text","text":"visible\nonly"}]});
        let part=Part::parse(&json!({"part":"text"})).unwrap();
        assert_eq!(event_part(&body,&Value::Null,&Value::Null,&part,"writer",None).unwrap(),"visible\nonly");
        assert!(event_part(&body,&Value::Null,&Value::Null,&Part::parse(&json!({"part":"thinking"})).unwrap(),"writer",None).is_err());
    }
    #[test]
    fn reply_selection_source_tool_scalars_keys_and_redaction() {
        let part=Part::parse(&json!({"part":"tool.input","tool_id":"call","pointer":"/command"})).unwrap();
        let body=json!({"tools":[{"id":"call","name":"orgtree_watchdog"}]});
        let inputs=json!({"call":{"input":{"command":"one\ntwo","credentials":{"password":"CANARY"}}}});
        assert_eq!(event_part(&body,&inputs,&Value::Null,&part,"writer",None).unwrap(),"one\ntwo");
        let raw=Part::parse(&json!({"part":"tool.input","tool_id":"call"})).unwrap();
        assert!(!event_part(&body,&inputs,&Value::Null,&raw,"writer",None).unwrap().contains("CANARY"));
        let key=Part::parse(&json!({"part":"tool.input","tool_id":"call","pointer":"/a~1b~0c","role":"key"})).unwrap();
        assert_eq!(input_part(&json!({"a/b~c":"value"}),&key).unwrap(),"a/b~c");
    }
    #[test]
    fn reply_selection_source_retained_shell_output_and_result_pointers() {
        let body=json!({"tools":[{"id":"call","result":"clipped"}]});
        let kept=json!({"call":{"failed_shell_output":{"output":"full retained output"}}});
        let part=Part::parse(&json!({"part":"tool.result","tool_id":"call"})).unwrap();
        assert_eq!(event_part(&body,&kept,&Value::Null,&part,"writer",None).unwrap(),"full retained output");
        let body=json!({"tools":[{"id":"call","result":"{\"a/b\":\"same\",\"other\":\"same\"}"}]});
        let part=Part::parse(&json!({"part":"tool.result","tool_id":"call","pointer":"/a~1b","role":"key"})).unwrap();
        assert_eq!(event_part(&body,&Value::Null,&Value::Null,&part,"writer",None).unwrap(),"a/b");
        let clipped=json!({"tools":[{"id":"call","result":"{\"a/b\":\"same"}]});
        assert!(event_part(&clipped,&Value::Null,&Value::Null,&part,"writer",None).is_err());
    }
    #[test]
    fn reply_selection_source_docket_duplicates_and_field_identity() {
        let part=Part::parse(&json!({"part":"work_item.done_so_far","entry":0})).unwrap();
        assert!(docket_part(&json!({"done_so_far":["same","same"]}),&part).is_err());
        assert_eq!(docket_part(&json!({"done_so_far":["one","two"]}),&part).unwrap(),"one");
    }
}
