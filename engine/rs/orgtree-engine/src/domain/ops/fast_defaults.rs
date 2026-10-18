//! Org hiring-speed policy: reads need no org-wide authority, writes do.
use super::*;

#[nolog]
fn require_top_level(has_superior: bool) -> Result<()> {
    if has_superior { refuse!(Forbidden,"only top-level agents whose superior is the user can change org fast-mode defaults"); }
    Ok(())
}

#[logged]
pub(super) async fn run(engine: &Arc<Engine>, org: &Arc<OrgHandle>, tx: &Transaction<'_>,
    actor: &Actor, req: &Value, fx: &mut Effects) -> Result<Value> {
    let action=req["action"].as_str().unwrap_or("read");
    if !matches!(action,"read"|"set") { refuse!(BadRequest,"fast defaults action must be read or set"); }
    if action=="read" && req.get("tiers").is_some() { refuse!(BadRequest,"tiers requires action=set"); }
    let mut stored: Value = if action=="set" {
        tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1 FOR NO KEY UPDATE",&[&org.id]).await?.get(0)
    } else { tx.query_one("SELECT settings FROM ot.orgs WHERE id=$1",&[&org.id]).await?.get(0) };
    if action=="set" {
        if let Actor::Agent{id,..}=actor {
            let ancestors=chain(tx,*id).await?;
            let me=ancestors.iter().find(|n|n.id==*id).ok_or_else(||anyhow::anyhow!("caller missing"))?;
            if me.state!="live" || me.project() { refuse!(Forbidden,"fast defaults need a live agent"); }
            require_top_level(ancestors.iter().any(|n| n.id!=*id && !n.project()))?;
        }
        let patch=crate::providers::fast_mode::validate_defaults(&engine.providers.state.load(),&req["tiers"])?;
        let mut next=crate::feed::groups::effective_settings(&stored,&engine.settings.defaults())["default_fast_mode"].clone();
        if !next.is_object() { next=json!({}); }
        for (tier,value) in patch.as_object().unwrap() { next[tier]=value.clone(); }
        stored["default_fast_mode"]=next.clone();
        tx.execute("UPDATE ot.orgs SET settings=$2 WHERE id=$1",&[&org.id,&stored]).await?;
        event(tx,org.id,"fast_defaults",actor,None,json!({"change":patch,"default_fast_mode":next}),fx).await?;
        fx.events=true; fx.pulses.push(crate::changes::Change::Org);
    }
    let settings=crate::feed::groups::effective_settings(&stored,&engine.settings.defaults());
    Ok(json!({"default_fast_mode":settings["default_fast_mode"],"applies":"future hires; explicit fast_mode overrides; rehire retains saved speed"}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn fast_tools_default_writes_require_top_level() {
        assert!(super::require_top_level(false).is_ok());
        assert!(super::require_top_level(true).is_err());
    }
}
