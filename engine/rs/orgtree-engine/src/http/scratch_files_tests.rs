//! The Files panel's routes: what keeps a request inside the folder, what a listing says,
//! that a zip made as a stream can be read back, and how an upload takes its place.

use super::*;
use axum::http::StatusCode;

/// A folder of this test's own, resolved as the routes resolve theirs, removed at the end.
struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        let dir = std::env::temp_dir().join(crate::util::uid("scratch-files-"));
        std::fs::create_dir_all(&dir).unwrap();
        Dir(std::fs::canonicalize(&dir).unwrap())
    }
    fn file(&self, path: &str, text: &[u8]) -> PathBuf {
        let at = self.0.join(path);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(&at, text).unwrap();
        at
    }
    fn folder(&self, path: &str) -> PathBuf {
        let at = self.0.join(path);
        std::fs::create_dir_all(&at).unwrap();
        at
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        // a junction is removed as the folder it is, never through it
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A link at `link` to the folder `to`: a junction on Windows (which needs no privilege), a
/// symbolic link elsewhere.
fn link_folder(link: &FsPath, to: &FsPath) {
    #[cfg(windows)]
    {
        // mklink takes no \\?\ path
        let (link, to) = (crate::config::strip_verbatim(link), crate::config::strip_verbatim(to));
        let done = std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(link).arg(to).output().unwrap();
        assert!(done.status.success(), "mklink /J: {}", String::from_utf8_lossy(&done.stderr));
    }
    #[cfg(not(windows))]
    std::os::unix::fs::symlink(to, link).unwrap();
}

fn status<T: std::fmt::Debug>(result: Refused<T>) -> StatusCode {
    result.expect_err("refused").0
}

#[test]
fn a_path_names_only_what_is_stored_inside_the_folder() {
    let (inside, outside) = (Dir::new(), Dir::new());
    inside.file("logs/run/out.txt", b"out");
    outside.file("secret.txt", b"secret");
    // plain paths, with either separator, and the folder itself
    assert_eq!(confine(&inside.0, "").unwrap(), inside.0);
    assert_eq!(confine(&inside.0, "logs/run/out.txt").unwrap(), inside.0.join("logs").join("run").join("out.txt"));
    assert_eq!(confine(&inside.0, "/logs\\run/").unwrap(), inside.0.join("logs").join("run"));
    // nothing that leaves it by its spelling
    let sibling = format!("../{}/secret.txt", outside.0.file_name().unwrap().to_string_lossy());
    for path in ["..", "logs/../..", sibling.as_str(), "logs/./run", "C:/Windows", "C:", "logs/run/out.txt:stream", "logs/*"] {
        assert_eq!(status(confine(&inside.0, path)), StatusCode::BAD_REQUEST, "{path}");
    }
    let absolute = outside.0.join("secret.txt").to_string_lossy().to_string();
    assert_ne!(confine(&inside.0, &absolute).ok(), Some(outside.0.join("secret.txt")), "an absolute path is not taken as one");
    // nothing that is not there
    assert_eq!(status(confine(&inside.0, "logs/none.txt")), StatusCode::NOT_FOUND);
    // and nothing through a link: the link itself, and anything named beyond it
    link_folder(&inside.0.join("logs").join("away"), &outside.0);
    assert_eq!(status(confine(&inside.0, "logs/away")), StatusCode::FORBIDDEN);
    assert_eq!(status(confine(&inside.0, "logs/away/secret.txt")), StatusCode::FORBIDDEN);
    assert_eq!(status(confine_folder(&inside.0, "logs/run/out.txt")), StatusCode::BAD_REQUEST, "a file is not a folder");
    // the link is taken away before the folders are, so nothing is removed through it
    std::fs::remove_dir(inside.0.join("logs").join("away")).unwrap();
    assert!(outside.0.join("secret.txt").exists());
}

#[test]
fn a_listing_has_folders_first_then_files_by_name_a_page_at_a_time() {
    let (dir, outside) = (Dir::new(), Dir::new());
    for name in ["b.txt", "A.txt", "c.log"] {
        dir.file(name, b"12345");
    }
    dir.folder("zeta");
    dir.folder("Alpha");
    dir.file(".up0123456789ab.orgtree-part", b"half an upload");
    link_folder(&dir.0.join("elsewhere"), &outside.0);
    let page = listing(&dir.0, 0, 4).unwrap();
    let names = |page: &Value| page["entries"].as_array().unwrap().iter().map(|e| format!("{}:{}", e["kind"].as_str().unwrap(), e["name"].as_str().unwrap())).collect::<Vec<_>>();
    assert_eq!(names(&page), ["folder:Alpha", "folder:zeta", "file:A.txt", "file:b.txt"]);
    assert_eq!((page["total"].as_u64(), page["next"].as_u64()), (Some(6), Some(4)), "the upload in progress is not counted");
    assert_eq!(page["entries"][2]["bytes"], 5);
    assert!(page["entries"][2]["modified"].as_u64().is_some_and(|ms| ms > 1_600_000_000_000));
    assert!(page["entries"][0]["bytes"].is_null());
    let rest = listing(&dir.0, 4, 4).unwrap();
    assert_eq!(names(&rest), ["file:c.log", "link:elsewhere"]);
    assert!(rest["next"].is_null() && rest["entries"][1]["bytes"].is_null());
    std::fs::remove_dir(dir.0.join("elsewhere")).unwrap();
}

// ------------------------------------------------------------ reading a zip back

fn u16_at(bytes: &[u8], at: usize) -> usize {
    u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

/// The entries of a zip, read the way a zip reader does: from its end records and its central
/// directory, then each file from where the directory says it starts. `(name, content)`; a
/// folder has no content.
fn unzip(zip: &[u8]) -> Vec<(String, Option<Vec<u8>>)> {
    let end = zip.len() - 22;
    assert_eq!(u32_at(zip, end), 0x0605_4b50, "the end record");
    let locator = end - 20;
    assert_eq!(u32_at(zip, locator), 0x0706_4b50, "the ZIP64 locator");
    let end64 = u64_at(zip, locator + 8) as usize;
    assert_eq!(u32_at(zip, end64), 0x0606_4b50, "the ZIP64 end record");
    let (count, length, start) = (u64_at(zip, end64 + 32), u64_at(zip, end64 + 40) as usize, u64_at(zip, end64 + 48) as usize);
    assert_eq!(start + length, end64, "the directory ends where the end records begin");
    let (mut at, mut entries) = (start, Vec::new());
    for _ in 0..count {
        assert_eq!(u32_at(zip, at), 0x0201_4b50, "a directory entry");
        let (method, crc) = (u16_at(zip, at + 10), u32_at(zip, at + 16));
        let (name_len, extra_len) = (u16_at(zip, at + 28), u16_at(zip, at + 30));
        let name = String::from_utf8(zip[at + 46..at + 46 + name_len].to_vec()).unwrap();
        let extra = at + 46 + name_len;
        assert_eq!((u16_at(zip, extra), u16_at(zip, extra + 2)), (1, 24), "the ZIP64 field of {name}");
        let (size, packed, offset) = (u64_at(zip, extra + 4) as usize, u64_at(zip, extra + 12) as usize, u64_at(zip, extra + 20) as usize);
        at = extra + extra_len;
        assert_eq!(u32_at(zip, offset), 0x0403_4b50, "the local header of {name}");
        let data = offset + 30 + u16_at(zip, offset + 26) + u16_at(zip, offset + 28);
        assert_eq!(&zip[offset + 30..offset + 30 + name_len], name.as_bytes());
        if name.ends_with('/') {
            assert_eq!((method, size, packed), (0, 0, 0));
            entries.push((name, None));
            continue;
        }
        assert_eq!(method, 8, "{name} is deflated");
        let mut content = Vec::new();
        flate2::read::DeflateDecoder::new(&zip[data..data + packed]).read_to_end(&mut content).unwrap();
        assert_eq!(content.len(), size, "{name}");
        let mut sum = flate2::Crc::new();
        sum.update(&content);
        assert_eq!(sum.sum(), crc, "the checksum of {name}");
        // the sizes that follow the data say the same
        let after = data + packed;
        assert_eq!((u32_at(zip, after), u32_at(zip, after + 4), u64_at(zip, after + 8) as usize, u64_at(zip, after + 16) as usize), (0x0807_4b50, crc, packed, size), "{name}");
        entries.push((name, Some(content)));
    }
    assert_eq!(at, start + length);
    entries
}

fn zipped(folder: &FsPath, prefix: &str) -> Vec<u8> {
    let mut out = Vec::new();
    zip_tree(folder, prefix, &mut |bytes| {
        out.extend_from_slice(&bytes);
        true
    })
    .unwrap();
    out
}

#[test]
fn a_folder_is_zipped_as_a_stream_that_reads_back_whole() {
    let (dir, outside) = (Dir::new(), Dir::new());
    // larger than one chunk, and not all the same, so the deflate runs over several reads
    let big: Vec<u8> = (0..300_000u32).flat_map(|n| (n.wrapping_mul(2_654_435_761) >> 13).to_le_bytes()).collect();
    dir.file("pack/big.bin", &big);
    dir.file("pack/notes/ünïcode name.txt", "héllo".as_bytes());
    dir.file("pack/empty.txt", b"");
    dir.folder("pack/nothing-in-here");
    dir.file("pack/.up0123456789ab.orgtree-part", b"half an upload");
    outside.file("secret.txt", b"secret");
    link_folder(&dir.0.join("pack").join("away"), &outside.0);
    let entries = unzip(&zipped(&dir.0.join("pack"), "pack"));
    let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["pack/", "pack/big.bin", "pack/empty.txt", "pack/nothing-in-here/", "pack/notes/", "pack/notes/ünïcode name.txt"],
        "by name, a folder before what is in it; no link, no upload in progress");
    let content = |name: &str| entries.iter().find(|(n, _)| n == name).and_then(|(_, content)| content.clone()).unwrap();
    assert!(content("pack/big.bin") == big);
    assert_eq!(content("pack/notes/ünïcode name.txt"), "héllo".as_bytes());
    assert_eq!(content("pack/empty.txt"), b"");
    // the whole folder, with no name in front
    let names: Vec<String> = unzip(&zipped(&dir.0.join("pack").join("notes"), "")).into_iter().map(|(name, _)| name).collect();
    assert_eq!(names, ["ünïcode name.txt"]);
    // nobody is reading any more: the making stops, with no error
    let mut taken = 0;
    zip_tree(&dir.0.join("pack"), "pack", &mut |_| {
        taken += 1;
        taken < 3
    })
    .unwrap();
    assert_eq!(taken, 3);
    std::fs::remove_dir(dir.0.join("pack").join("away")).unwrap();
}

#[test]
fn the_time_of_a_zip_entry() {
    use std::time::{Duration, UNIX_EPOCH};
    // 2026-11-14 10:20:30 UTC
    let (time, date) = dos_time(Some(UNIX_EPOCH + Duration::from_secs(1_794_651_630)));
    assert_eq!((date >> 9, (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2), (2026 - 1980, 11, 14, 10, 20, 30));
    assert_eq!(dos_time(Some(UNIX_EPOCH)), (0, 0x21), "before 1980: the first day a zip can name");
    assert_eq!(dos_time(None), (0, 0x21));
}

// ------------------------------------------------------------ an upload takes its place

#[test]
fn the_names_a_file_may_be_uploaded_under() {
    for name in ["notes.txt", "a b (2).tar.gz", ".gitignore", "ünï.md", "COM10.txt", "console.log"] {
        assert!(upload_name(name), "{name}");
    }
    for name in ["", ".", "..", "a/b", "a\\b", "C:x", "a:b", "tab\there", "what?", "con", "NUL.txt", "com1", "LPT9.log", "trailing.", "trailing ", " leading", ".up0123456789ab.orgtree-part"] {
        assert!(!upload_name(name), "{name:?}");
    }
    assert!(!upload_name(&"x".repeat(256)));
    assert_eq!((numbered("notes.txt", 2), numbered("a.tar.gz", 3), numbered("Makefile", 2), numbered(".env", 2)), ("notes (2).txt".into(), "a.tar (3).gz".into(), "Makefile (2)".into(), ".env (2)".into()));
}

#[test]
fn a_finished_upload_is_placed_by_the_users_choice() {
    let (dir, outside) = (Dir::new(), Dir::new());
    let part = |text: &[u8]| dir.file(&format!(".{}.orgtree-part", crate::util::uid("up")), text);
    let read = |name: &str| std::fs::read(dir.0.join(name)).unwrap();
    // nothing in the way
    assert_eq!(place(&dir.0, &part(b"one"), "notes.txt", Conflict::Ask).unwrap(), "notes.txt");
    assert_eq!(read("notes.txt"), b"one");
    // a file of that name: asked, it is refused, and what is there stays whole
    let second = part(b"two");
    assert_eq!(place(&dir.0, &second, "notes.txt", Conflict::Ask), Err((StatusCode::CONFLICT, EXISTS)));
    assert_eq!(in_the_way(&dir.0, "notes.txt", Conflict::Ask), Err((StatusCode::CONFLICT, EXISTS)));
    assert_eq!(read("notes.txt"), b"one");
    assert!(second.exists(), "the caller's guard removes the part, not this");
    // keep both: the new one gets the first free number
    assert_eq!(place(&dir.0, &second, "notes.txt", Conflict::KeepBoth).unwrap(), "notes (2).txt");
    assert_eq!(place(&dir.0, &part(b"three"), "notes.txt", Conflict::KeepBoth).unwrap(), "notes (3).txt");
    assert_eq!((read("notes.txt"), read("notes (2).txt"), read("notes (3).txt")), (b"one".to_vec(), b"two".to_vec(), b"three".to_vec()));
    // replace
    assert_eq!(place(&dir.0, &part(b"four"), "notes.txt", Conflict::Replace).unwrap(), "notes.txt");
    assert_eq!(read("notes.txt"), b"four");
    // a folder of that name is never replaced, and a link is never written through
    dir.folder("taken");
    outside.file("notes.txt", b"theirs");
    link_folder(&dir.0.join("away"), &outside.0);
    std::fs::write(dir.0.join("linked.txt"), b"").unwrap();
    for conflict in [Conflict::Ask, Conflict::Replace, Conflict::KeepBoth] {
        assert_eq!(place(&dir.0, &part(b"five"), "taken", conflict), Err((StatusCode::CONFLICT, FOLDER_IN_THE_WAY)), "{conflict:?}");
        assert_eq!(place(&dir.0, &part(b"five"), "away", conflict), Err((StatusCode::FORBIDDEN, LINK)), "{conflict:?}");
    }
    assert_eq!(std::fs::read(outside.0.join("notes.txt")).unwrap(), b"theirs");
    std::fs::remove_dir(dir.0.join("away")).unwrap();
}

#[test]
fn an_upload_that_ends_badly_leaves_no_part_behind() {
    let dir = Dir::new();
    let at = dir.file(".up0123456789ab.orgtree-part", b"half");
    drop(Part(Some(at.clone())));
    assert!(!at.exists());
    let kept = dir.file(".upba9876543210.orgtree-part", b"whole");
    let mut guard = Part(Some(kept.clone()));
    guard.0 = None;
    drop(guard);
    assert!(kept.exists(), "a placed upload is not removed");
}

#[test]
fn a_download_is_named_for_any_reader() {
    assert_eq!(disposition("notes.txt"), "attachment; filename=\"notes.txt\"; filename*=UTF-8''notes%2Etxt");
    assert_eq!(disposition("ün \"q\".txt"), "attachment; filename=\"_n _q_.txt\"; filename*=UTF-8''%C3%BCn%20%22q%22%2Etxt");
    assert_eq!((folder_label("lead", ScratchFolderScope::Agent), folder_label("lead", ScratchFolderScope::Team), folder_label("_shared", ScratchFolderScope::Shared)),
        ("lead".to_string(), "lead-team".to_string(), "shared".to_string()));
}
