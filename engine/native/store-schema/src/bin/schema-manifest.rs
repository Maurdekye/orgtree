//! Print the checksum manifest for the current migration files.
//! Used only when adding a NEW migration; a landed file's line never changes.
fn main() {
    print!("{}", orgtree_store_schema::computed_manifest());
}
