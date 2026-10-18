//! Exercise the actual registered view SQL. SQLite adapts only PostgreSQL's
//! NULL cast and CREATE OR REPLACE syntax; no live or application DB is opened.
use rusqlite::Connection;

fn fixture() -> Connection {
    let db=Connection::open_in_memory().unwrap();
    db.execute_batch("ATTACH DATABASE ':memory:' AS ot;
        CREATE TABLE ot.agents(id INTEGER PRIMARY KEY,org_id INTEGER,name TEXT,parent_id INTEGER,kind TEXT,state TEXT);
        CREATE TABLE ot.audiences(id INTEGER PRIMARY KEY,org_id INTEGER,grantee TEXT,grantor TEXT,granted_at TEXT,reason TEXT,revoked_at TEXT,paused BOOLEAN DEFAULT false);
        INSERT INTO ot.agents VALUES(1,1,'alpha',NULL,'project','live'),(2,1,'beta',NULL,'project','live'),
            (3,1,'a',1,'agent','live'),(4,1,'b',2,'agent','live'),
            (5,1,'nested-a',1,'project','live'),(6,1,'deep-a',5,'agent','live'),
            (7,1,'nested-b',2,'project','live'),(8,1,'deep-b',7,'agent','live'),
            (9,2,'other-org',2,'agent','live'),(10,1,'retired',2,'agent','retired');
        INSERT INTO ot.audiences(id,org_id,grantee,grantor) VALUES(1,1,'alpha','beta'),(2,1,'alpha','@user'),(3,1,'alpha','single');").unwrap();
    for (name,sql) in super::MIGRATIONS {
        if *name=="0030_project_audiences" || name.ends_with("_project_member_audiences") {
            db.execute_batch(&sql.replace("::text", "").replace("CREATE OR REPLACE VIEW ot.effective_audiences AS",
                "DROP VIEW ot.effective_audiences; CREATE VIEW ot.effective_audiences AS")).unwrap();
        }
    }
    db
}
fn holds(db:&Connection,from:&str,to:&str)->bool {
    db.query_row("SELECT EXISTS(SELECT 1 FROM ot.effective_audiences WHERE org_id=1 AND grantee=?1 AND grantor=?2)",
        (from,to),|r|r.get(0)).unwrap()
}

#[test]
fn one_way_project_audience_reaches_other_direct_members() {
    let db=fixture();
    assert!(holds(&db,"a","b"));
    assert!(!holds(&db,"b","a"));
}
#[test]
fn reciprocal_project_audiences_enable_both_directions() {
    let db=fixture();
    db.execute("INSERT INTO ot.audiences(id,org_id,grantee,grantor) VALUES(4,1,'beta','alpha')",[]).unwrap();
    assert!(holds(&db,"a","b")); assert!(holds(&db,"b","a"));
}
#[test]
fn project_target_membership_changes_immediately() {
    let db=fixture();
    assert!(holds(&db,"a","b"));
    db.execute("UPDATE ot.agents SET parent_id=NULL WHERE name='b'",[]).unwrap();
    assert!(!holds(&db,"a","b"));
    db.execute("UPDATE ot.agents SET parent_id=2 WHERE name='b'",[]).unwrap();
    assert!(holds(&db,"a","b"));
    db.execute("UPDATE ot.audiences SET paused=true WHERE id=1",[]).unwrap();
    assert!(!holds(&db,"a","b"));
}
#[test]
fn nested_members_other_org_and_retired_targets_are_excluded() {
    let db=fixture();
    for (from,to) in [("deep-a","b"),("a","deep-b"),("a","other-org"),("a","retired")] {
        assert!(!holds(&db,from,to),"unexpected inherited route {from}->{to}");
    }
}
#[test]
fn user_agent_and_project_endpoint_grants_remain_effective() {
    let db=fixture();
    for to in ["@user","single","beta"] { assert!(holds(&db,"a",to)); }
    assert!(!holds(&db,"deep-a","@user"));
    assert_eq!(db.query_row("SELECT count(*) FROM ot.audiences WHERE grantee='a'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
}
#[test]
fn revocation_and_retiring_source_project_remove_routes() {
    let db=fixture();
    db.execute("UPDATE ot.audiences SET revoked_at='now' WHERE id=1",[]).unwrap();
    assert!(!holds(&db,"a","b"));
    db.execute("UPDATE ot.agents SET state='retired' WHERE name='alpha'",[]).unwrap();
    assert!(!holds(&db,"a","@user"));
}
