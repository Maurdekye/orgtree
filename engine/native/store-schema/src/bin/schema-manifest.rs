//! Print the checksum manifest for one range's current migration files:
//! `schema-manifest <range name, e.g. WS2>` → the content of
//! `ranges/<range>.sha256`. Used only when adding a NEW migration; a landed
//! file's line never changes.
fn main() {
    let want = std::env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: schema-manifest <range name>");
        std::process::exit(2)
    });
    match orgtree_store_schema::RANGE_DEFS.iter().find(|r| r.name.eq_ignore_ascii_case(&want)) {
        Some(r) => print!("{}", r.computed_manifest()),
        None => {
            eprintln!("no range named {want}");
            std::process::exit(2)
        }
    }
}
