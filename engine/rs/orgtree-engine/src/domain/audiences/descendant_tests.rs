//! Audience grants, denials and revocations between two agents of one subtree (USER 2026-11-03
//! m6b316c65b4ab "staff that please"; spec rev 1 by stream-plan-opus, cases A/R/D/G/P/T). Synthetic PG
//! fixture: each test builds its own disposable `ot` schema, so run them one at a time
//! (`--test-threads=1 --ignored`) against a throwaway database named and owned `audience_fixture`
//! (ORGTREE_AUDIENCE_TEST_URL, ORGTREE_AUDIENCE_TEST_ROOT). Nothing starts a CLI or a provider.
//!
//! The tree: `C` (top) -> `crm` (agent), `court-game` (project) -> `arch` (agent), `S` (agent) -> `deep`
//! (agent); `X` (top, separate) -> `out` (agent).
use super::*;
use tokio_postgres::NoTls;

struct World {
    e: Arc<Engine>,
    org: Arc<OrgHandle>,
}

#[nolog]
async fn world() -> World {
    let url = std::env::var("ORGTREE_AUDIENCE_TEST_URL").expect("explicit synthetic fixture URL");
    let cfg: tokio_postgres::Config = url.parse().unwrap();
    assert_eq!(cfg.get_dbname(), Some("audience_fixture"));
    assert_eq!(cfg.get_user(), Some("audience_fixture"));
    let (mut client, connection) = cfg.connect(NoTls).await.unwrap();
    tokio::spawn(async move { let _ = connection.await; });
    client.batch_execute("DROP SCHEMA IF EXISTS ot CASCADE; DROP TABLE IF EXISTS public.ot_migrations").await.unwrap();
    crate::migrate::run(&mut client, &|_| {}).await.unwrap();
    let id: i64 = client.query_one("INSERT INTO ot.orgs(uuid,slug,name) VALUES(gen_random_uuid(),'audience-fixture','fixture') RETURNING id", &[]).await.unwrap().get(0);
    let node = |name: &'static str, kind: &'static str, parent: Option<i64>| {
        let client = &client;
        async move {
            let tier = if kind == "project" { "project" } else { "sol" };
            client.query_one("INSERT INTO ot.agents(org_id,name,kind,parent_id,tier,state,born) VALUES($1,$2,$3,$4,$5,'live','2026-11-03') RETURNING id",
                &[&id, &name, &kind, &parent, &tier]).await.unwrap().get::<_, i64>(0)
        }
    };
    let c = node("C", "agent", None).await;
    node("crm", "agent", Some(c)).await;
    let court = node("court-game", "project", Some(c)).await;
    node("arch", "agent", Some(court)).await;
    let s = node("S", "agent", Some(c)).await;
    node("deep", "agent", Some(s)).await;
    let x = node("X", "agent", None).await;
    node("out", "agent", Some(x)).await;
    let mut engine = Engine::for_tests(std::path::PathBuf::from(std::env::var("ORGTREE_AUDIENCE_TEST_ROOT").expect("owned engine root")));
    let mgr = deadpool_postgres::Manager::from_config(cfg, NoTls, deadpool_postgres::ManagerConfig { recycling_method: deadpool_postgres::RecyclingMethod::Fast });
    Arc::get_mut(&mut engine).unwrap().db = deadpool_postgres::Pool::builder(mgr).max_size(4).runtime(deadpool_postgres::Runtime::Tokio1).build().unwrap();
    let org = crate::orgs::provisional(id, "fixture".into(), "audience-fixture".into(), "fixture".into());
    engine.orgs.insert(org.clone());
    World { e: engine, org }
}

impl World {
    #[nolog]
    async fn id(&self, name: &str) -> i64 {
        self.e.db.get().await.unwrap().query_one("SELECT id FROM ot.agents WHERE org_id = $1 AND name = $2", &[&self.org.id, &name]).await.unwrap().get(0)
    }
    #[nolog]
    async fn actor(&self, name: &str) -> Actor {
        Actor::Agent { id: self.id(name).await, name: name.to_string() }
    }
    /// `by` grants `from` an audience with `target`.
    #[nolog]
    async fn grant(&self, by: &str, from: &str, target: &str) -> Result<Value> {
        grant(&self.e, &self.org, &self.actor(by).await, from, Some(target), "").await
    }
    #[nolog]
    async fn revoke(&self, by: &str, grantee: &str, grantor: &str) -> Result<Value> {
        revoke(&self.e, &self.org, &self.actor(by).await, grantee, Some(grantor)).await
    }
    #[nolog]
    async fn request(&self, requester: &str, target: &str) -> Value {
        let me = self.id(requester).await;
        request(&self.e, &self.org, (me, requester), None, target, "need it").await.unwrap()
    }
    #[nolog]
    async fn deny(&self, by: &str, requester: &str, target: &str) -> Result<Value> {
        deny(&self.e, &self.org, &self.actor(by).await, requester, Some(target)).await
    }
    #[nolog]
    async fn sql(&self, text: &str, params: &[&(dyn tokio_postgres::types::ToSql + Sync)]) {
        self.e.db.get().await.unwrap().execute(text, params).await.unwrap();
    }
    /// The in-process send `orgtree_message` reaches (`mail::send`: route and reach checks); no wake, no runtime.
    #[nolog]
    async fn send(&self, from: &str, to: &str) -> Result<mail::Sent> {
        let id = self.id(from).await;
        let mut out = Outgoing::new(From::Agent { id, name: from.to_string(), generation: 1 }, to, "audience probe");
        out.wake = false;
        mail::send(&self.e, self.org.id, out).await
    }
    #[nolog]
    async fn inbox_rows(&self, agent: &str, sender: &str) -> i64 {
        let to = self.id(agent).await;
        self.e.db.get().await.unwrap().query_one("SELECT count(*) FROM ot.mail WHERE org_id = $1 AND recipient_agent_id = $2 AND sender = $3 AND body = 'audience probe'",
            &[&self.org.id, &to, &sender]).await.unwrap().get(0)
    }
    /// Does `grantee` hold an active explicit audience with `grantor`?
    #[nolog]
    async fn holds(&self, grantee: &str, grantor: &str) -> bool {
        let c = self.e.db.get().await.unwrap();
        c.query_one("SELECT EXISTS (SELECT 1 FROM ot.audiences WHERE org_id = $1 AND grantee = $2 AND grantor = $3 AND revoked_at IS NULL)",
            &[&self.org.id, &grantee, &grantor]).await.unwrap().get(0)
    }
    #[nolog]
    async fn request_status(&self, requester: &str, target: &str) -> String {
        let c = self.e.db.get().await.unwrap();
        c.query_one("SELECT status FROM ot.audience_requests WHERE org_id = $1 AND requester = $2 AND target = $3 ORDER BY id DESC LIMIT 1",
            &[&self.org.id, &requester, &target]).await.unwrap().get(0)
    }
    /// The newest audit event of `op` and its actor.
    #[nolog]
    async fn event_actor(&self, op: &str) -> Option<String> {
        let c = self.e.db.get().await.unwrap();
        c.query_opt("SELECT actor FROM ot.events WHERE org_id = $1 AND op = $2 ORDER BY id DESC LIMIT 1", &[&self.org.id, &op]).await.unwrap().map(|r| r.get(0))
    }
    /// Is there a System note to the agent containing every needle?
    #[nolog]
    async fn told(&self, agent: &str, needles: &[&str]) -> bool {
        let to = self.id(agent).await;
        let c = self.e.db.get().await.unwrap();
        let rows = c.query("SELECT body FROM ot.mail WHERE org_id = $1 AND recipient_agent_id = $2", &[&self.org.id, &to]).await.unwrap();
        rows.iter().any(|r| { let b: String = r.get(0); needles.iter().all(|n| b.contains(n)) })
    }
}

const SUBTREE: &str = "between two live agents in your subtree";
const RESCIND: &str = "audiences between two agents in your subtree";

#[nolog]
fn refused(r: Result<Value>, needle: &str) {
    let e = r.expect_err("must be refused");
    assert!(format!("{e:#}").contains(needle), "refusal {e:#} should contain {needle:?}");
}

macro_rules! db_test { ($name:ident, $w:ident, $body:block) => {
    #[tokio::test]
    #[ignore = "requires the disposable audience_fixture DB/role; never an ambient DB"]
    async fn $name() { let $w = world().await; $body }
}; }

db_test!(a1_the_common_ancestor_grants_across_a_project_node, w, {
    w.grant("C", "crm", "arch").await.unwrap();
    assert!(w.holds("crm", "arch").await);
    assert_eq!(w.event_actor("audience_grant").await.as_deref(), Some("C"));
});
db_test!(a2_it_reaches_past_a_sub_coordinator_and_across_a_project, w, {
    w.grant("C", "deep", "arch").await.unwrap();
    assert!(w.holds("deep", "arch").await);
});
db_test!(a3_the_three_x_peer_rule_still_lets_s_give_its_report_an_audience_with_its_own_peer_control, w, {
    // crm is S's physical peer (both under C): the preserved peer rule (spec rev 1.1, D3) permits it at red and green
    w.grant("S", "deep", "crm").await.unwrap();
    assert!(w.holds("deep", "crm").await);
});
db_test!(a3b_a_sub_coordinator_cannot_grant_to_someone_outside_its_subtree, w, {
    // arch sits under court-game: not S's peer, superior or descendant
    refused(w.grant("S", "deep", "arch").await, SUBTREE);
    assert!(!w.holds("deep", "arch").await);
});
db_test!(a4_nor_to_another_top_level_agents_report, w, {
    refused(w.grant("C", "crm", "out").await, SUBTREE);
});
db_test!(a5_a_project_target_keeps_the_project_rule_control, w, {
    w.grant("C", "crm", "court-game").await.unwrap();
    assert!(w.holds("crm", "court-game").await);
});
db_test!(a6_an_agent_that_is_not_an_ancestor_cannot_grant, w, {
    assert!(w.grant("deep", "crm", "arch").await.is_err());
    assert!(!w.holds("crm", "arch").await);
});
db_test!(a7_a_retired_endpoint_is_refused, w, {
    w.sql("UPDATE ot.agents SET state = 'archived' WHERE org_id = $1 AND name = 'arch'", &[&w.org.id]).await;
    refused(w.grant("C", "crm", "arch").await, "no live agent or project named arch");
});
db_test!(a8_two_direct_children_still_work_regression_control, w, {
    w.sql("INSERT INTO ot.agents(org_id,name,kind,parent_id,tier,state,born) SELECT org_id,'ops','agent',parent_id,'sol','live','2026-11-03' FROM ot.agents WHERE org_id = $1 AND name = 'crm'", &[&w.org.id]).await;
    w.grant("C", "crm", "ops").await.unwrap();
    assert!(w.holds("crm", "ops").await);
});

db_test!(r1_the_common_ancestor_revokes_and_the_grantee_is_told, w, {
    w.grant("C", "crm", "arch").await.unwrap();
    w.revoke("C", "crm", "arch").await.unwrap();
    assert!(!w.holds("crm", "arch").await);
    assert!(w.told("crm", &["C"]).await, "the notice to crm names C");
});
db_test!(r2_a_sub_coordinator_cannot_revoke_what_it_does_not_cover, w, {
    w.grant("C", "deep", "arch").await.unwrap();
    refused(w.revoke("S", "deep", "arch").await, RESCIND);
    assert!(w.holds("deep", "arch").await);
});
db_test!(r3_a_move_out_keeps_the_grant_and_the_old_ancestor_loses_the_right, w, {
    assert!(w.send("crm", "arch").await.is_err(), "before the grant the send is refused (negative control)");
    assert_eq!(w.inbox_rows("arch", "crm").await, 0);
    w.grant("C", "crm", "arch").await.unwrap();
    let x = w.id("X").await;
    w.sql("UPDATE ot.agents SET parent_id = $2 WHERE org_id = $1 AND name = 'arch'", &[&w.org.id, &x]).await;
    refused(w.revoke("C", "crm", "arch").await, RESCIND);
    assert!(w.holds("crm", "arch").await, "the row is still active");
    let c = w.e.db.get().await.unwrap();
    assert!(effective_holds(&**c, w.org.id, "crm", "arch").await.unwrap(), "crm still reaches arch");
    drop(c);
    w.send("crm", "arch").await.expect("the kept grant still carries a real send");
    assert_eq!(w.inbox_rows("arch", "crm").await, 1);
});
db_test!(r4_after_the_move_the_user_or_the_grantor_can_still_revoke, w, {
    w.grant("C", "crm", "arch").await.unwrap();
    let x = w.id("X").await;
    w.sql("UPDATE ot.agents SET parent_id = $2 WHERE org_id = $1 AND name = 'arch'", &[&w.org.id, &x]).await;
    revoke(&w.e, &w.org, &Actor::User, "crm", Some("arch")).await.unwrap();
    assert!(!w.holds("crm", "arch").await);
    w.sql("UPDATE ot.agents SET parent_id = (SELECT id FROM ot.agents WHERE org_id = $1 AND name = 'court-game') WHERE org_id = $1 AND name = 'arch'", &[&w.org.id]).await;
    w.grant("C", "crm", "arch").await.unwrap();
    w.sql("UPDATE ot.agents SET parent_id = $2 WHERE org_id = $1 AND name = 'arch'", &[&w.org.id, &x]).await;
    w.revoke("arch", "crm", "arch").await.unwrap();
    assert!(!w.holds("crm", "arch").await, "arch itself (the grantor) can rescind");
});

db_test!(d1_the_common_ancestor_denies_a_request_between_its_descendants, w, {
    w.request("crm", "arch").await;
    w.deny("C", "crm", "arch").await.unwrap();
    assert_eq!(w.request_status("crm", "arch").await, "denied");
    assert!(w.told("crm", &["C", "declined"]).await);
});
db_test!(d2_an_ancestor_of_only_the_target_cannot_deny, w, {
    w.request("out", "arch").await;
    refused(w.deny("X", "out", "arch").await, "waiting on X");
});
db_test!(g1_granting_a_pending_request_resolves_it, w, {
    w.request("crm", "arch").await;
    w.grant("C", "crm", "arch").await.unwrap();
    assert_eq!(w.request_status("crm", "arch").await, "granted");
    assert!(w.told("crm", &["C", "granted your requested audience with arch"]).await);
});
db_test!(p1_a_granted_audience_stands_where_the_project_has_peer_mail_off, w, {
    w.sql("UPDATE ot.agents SET scope = '{\"peer_mail\": false}'::jsonb WHERE org_id = $1 AND name = 'court-game'", &[&w.org.id]).await;
    w.grant("C", "crm", "arch").await.unwrap();
    let c = w.e.db.get().await.unwrap();
    assert!(effective_holds(&**c, w.org.id, "crm", "arch").await.unwrap());
    drop(c);
    w.send("crm", "arch").await.expect("the granted audience carries a real send where peer mail is off");
    assert_eq!(w.inbox_rows("arch", "crm").await, 1);
});

#[test]
#[nolog]
fn t1_the_tool_descriptions_and_the_guide_state_the_new_rule() {
    let defs = include_str!("../../tools/defs.rs");
    assert_eq!(defs.matches("An agent above both may grant, deny or revoke between two agents in its subtree.").count(), 3,
        "the short, card and list descriptions of orgtree_audience");
    let guide = include_str!("../../../../../../docs/skills/orgtree-working/mail/tool-audience/SKILL.md");
    assert!(!guide.contains("Between two direct tree siblings"));
    assert!(guide.contains("Between two agents in your subtree"));
}
