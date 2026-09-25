//! Owner-only ACLs: the SDDL rule (pure) and the real Win32 create/read-back.

use orgtree_pg_custodian::acl::{self, is_owner_only, parse_sddl};

const ME: &str = "S-1-5-21-1-2-3-1001";

#[test]
fn the_owner_only_rule() {
    let good = format!("O:{ME}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})");
    assert!(is_owner_only(&parse_sddl(&good), ME));
    let dir = format!("O:{ME}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;{ME})");
    assert!(is_owner_only(&parse_sddl(&dir), ME));
    for bad in [
        format!("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})"),                     // wrong owner
        format!("O:{ME}D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})"),                    // not protected
        format!("O:{ME}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})(A;;FR;;;WD)"),       // Everyone read
        format!("O:{ME}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})(A;;FA;;;WD)"),       // Everyone full: extra trustee
        format!("O:{ME}D:P(A;ID;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})"),                 // inherited ACE
        format!("O:{ME}D:P(A;;FR;;;SY)(A;;FA;;;BA)(A;;FA;;;{ME})"),                   // not full access
        format!("O:{ME}D:P(A;;FA;;;SY)(A;;FA;;;{ME})"),                               // Administrators missing
        format!("O:{ME}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-9-9-9-500)"),      // someone else
    ] {
        assert!(!is_owner_only(&parse_sddl(&bad), ME), "{bad}");
    }
}

#[test]
fn created_files_and_folders_are_owner_only_from_birth() {
    let base = std::env::temp_dir().join(format!("orgtree-p03-acl-{}", orgtree_pg_custodian::win::random_hex(4).unwrap()));
    std::fs::create_dir_all(&base).unwrap();
    let dir = base.join("secrets");
    acl::create_owner_only_dir(&dir).unwrap();
    acl::require_owner_only(&dir).unwrap();
    let f = dir.join("pgpass.conf");
    acl::write_owner_only_file(&f, b"x").unwrap();
    acl::require_owner_only(&f).unwrap();
    // CREATE_NEW: never overwrites.
    assert_eq!(acl::write_owner_only_file(&f, b"y").unwrap_err().code, "acl.create");
    // A plain file created by ordinary means is NOT owner-only here.
    let plain = base.join("plain.txt");
    std::fs::write(&plain, "x").unwrap();
    assert_eq!(acl::require_owner_only(&plain).unwrap_err().code, "acl.not_owner_only");
    // Atomic replace keeps the rule.
    acl::replace_owner_only(&base.join("desc.json"), b"{}").unwrap();
    acl::replace_owner_only(&base.join("desc.json"), b"{\"v\":2}").unwrap();
    acl::require_owner_only(&base.join("desc.json")).unwrap();
    std::fs::remove_dir_all(&base).unwrap();
}
