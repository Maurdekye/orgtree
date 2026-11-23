//! Reading an export file (docs/rust-engine/agent-export.md, "The file").
//!
//! An export is somebody else's file until it is read: every check here is
//! made before anything is created from it. The manifest says what the file
//! is; the index names every part with its size and SHA-256, and the manifest
//! names the index's own digest; a part is used only when it is in the index
//! and reads back as the index says. Nothing in the zip that the index does
//! not name is ever unpacked, and a name that is not a plain path inside its
//! own folder is refused (`names::safe_parts`).

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::format::{self, End, IndexLine, Links, Manifest, Node, Nodes};
use crate::zipfile::{EntryReader, Limits, ZipError, ZipIn};

/// The most nodes one file may hold.
pub const NODES_LIMIT: usize = 20_000;
/// The index of a file of two million parts stays under this.
const INDEX_MAX: u64 = 512 * 1024 * 1024;
/// One record of a part written line by line: a document with its download, a transcript row.
const LINE_MAX: usize = 256 * 1024 * 1024;

/// An export opened for reading.
pub struct Export {
    zip: ZipIn,
    pub manifest: Manifest,
    pub nodes: Vec<Node>,
    pub links: Links,
    index: HashMap<String, IndexLine>,
    /// Each entry's place in the zip's own list, by name.
    places: HashMap<String, usize>,
    /// The file's own size.
    pub file_bytes: u64,
}

#[nolog]
fn unreadable(error: ZipError) -> anyhow::Error {
    match error {
        ZipError::Io(error) => anyhow::anyhow!("the export file could not be read: {error}"),
        other => crate::domain::user_err(crate::domain::UserError::Unprocessable, format!("this is not an export Orgtree can read: {other}")),
    }
}

#[nolog]
fn wrong(why: impl std::fmt::Display) -> anyhow::Error {
    crate::domain::user_err(crate::domain::UserError::Unprocessable, format!("this is not an export Orgtree can read: {why}"))
}

/// The records of one part, a line each.
pub struct Lines<'a> {
    name: String,
    reader: std::io::BufReader<EntryReader<'a>>,
    sha: Sha256,
    want: String,
    buffer: Vec<u8>,
    done: bool,
}

#[nolog]
impl Lines<'_> {
    /// The next record, or `None` at the end of the part, once it has read back as the index says.
    pub fn next(&mut self) -> Result<Option<Value>> {
        if self.done {
            return Ok(None);
        }
        loop {
            self.buffer.clear();
            let read = (&mut self.reader).take(LINE_MAX as u64 + 1).read_until(b'\n', &mut self.buffer).map_err(|error| wrong(format!("{}: {error}", self.name)))?;
            if read == 0 {
                self.done = true;
                if hex::encode(std::mem::take(&mut self.sha).finalize()) != self.want {
                    return Err(wrong(format!("{} is not what the file's index says", self.name)));
                }
                return Ok(None);
            }
            if read > LINE_MAX {
                return Err(wrong(format!("{} holds a record larger than any Orgtree writes", self.name)));
            }
            self.sha.update(&self.buffer);
            let line = self.buffer.strip_suffix(b"\n").unwrap_or(&self.buffer);
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            return serde_json::from_slice(line).map(Some).map_err(|error| wrong(format!("{}: {error}", self.name)));
        }
    }
}

#[nolog]
impl Export {
    /// Open `path` and check everything that can be checked without unpacking it.
    pub fn open(path: &Path) -> Result<Export> {
        let file_bytes = std::fs::metadata(path).map_err(|error| anyhow::anyhow!("the export file could not be read: {error}"))?.len();
        let mut zip = ZipIn::open(path, Limits::default()).map_err(unreadable)?;
        let places: HashMap<String, usize> = zip.entries().iter().enumerate().map(|(at, entry)| (entry.name.clone(), at)).collect();
        let whole = |zip: &mut ZipIn, name: &str, max: u64| -> Result<Vec<u8>> {
            let Some(entry) = places.get(name).map(|at| zip.entries()[*at].clone()) else { return Err(wrong(format!("it has no {name}"))) };
            zip.read_all(&entry, max).map_err(unreadable)
        };
        let manifest: Manifest = serde_json::from_slice(&whole(&mut zip, format::MANIFEST, format::MANIFEST_MAX)?).map_err(|error| wrong(format!("its manifest: {error}")))?;
        if manifest.kind != format::KIND {
            return Err(wrong("its manifest does not call it an Orgtree export"));
        }
        if manifest.format == 0 || manifest.format > format::FORMAT {
            crate::refuse!(Unprocessable, "this export was made by a newer Orgtree ({}); update this one to import it", manifest.orgtree_version);
        }
        let listed = whole(&mut zip, format::INDEX, INDEX_MAX)?;
        if hex::encode(Sha256::digest(&listed)) != manifest.index_sha256 {
            return Err(wrong("its index is not the one its manifest names"));
        }
        let mut index: HashMap<String, IndexLine> = HashMap::new();
        let mut unpacked = 0u64;
        for line in listed.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
            let line: IndexLine = serde_json::from_slice(line).map_err(|error| wrong(format!("its index: {error}")))?;
            if super::names::safe_parts(&line.name).is_none() {
                return Err(wrong("its index names a part outside the file's own folders"));
            }
            unpacked = unpacked.saturating_add(line.size);
            if index.insert(line.name.clone(), line).is_some() {
                return Err(wrong("its index names a part twice"));
            }
        }
        if unpacked > super::SIZE_MAX {
            crate::refuse!(Unprocessable, "this export holds more than 256 GiB");
        }
        let mut export = Export { zip, manifest, nodes: Vec::new(), links: Links::default(), index, places, file_bytes };
        let nodes: Nodes = serde_json::from_slice(&export.part(format::NODES, format::NODES_MAX)?.ok_or_else(|| wrong("it has no node list"))?)
            .map_err(|error| wrong(format!("its node list: {error}")))?;
        export.nodes = nodes.nodes;
        export.check_nodes()?;
        if let Some(links) = export.part(format::LINKS, format::LINKS_MAX)? {
            export.links = serde_json::from_slice(&links).map_err(|error| wrong(format!("its links: {error}")))?;
        }
        export.check_links()?;
        Ok(export)
    }

    /// The node list is a tree in tree order, of nodes this Orgtree can name.
    fn check_nodes(&self) -> Result<()> {
        if self.nodes.is_empty() {
            return Err(wrong("it holds no node"));
        }
        if self.nodes.len() > NODES_LIMIT {
            crate::refuse!(Unprocessable, "this export holds {} nodes; at most {NODES_LIMIT} can be imported at once", self.nodes.len());
        }
        for (at, node) in self.nodes.iter().enumerate() {
            let placed = match node.parent {
                None => at == 0,
                Some(parent) => at > 0 && parent < at,
            };
            if !placed {
                return Err(wrong("its node list is not one tree, each node after the one above it"));
            }
            if !matches!(node.kind.as_str(), "agent" | "project") {
                return Err(wrong(format!("a node of a kind this Orgtree does not know ({})", node.kind)));
            }
            if crate::domain::ops::valid_name(&node.name).ok().as_deref() != Some(node.name.as_str()) {
                return Err(wrong("a node with a name no node may have"));
            }
            if node.dir != format::node_dir(at, &node.name) {
                return Err(wrong("a node whose parts are not where its place in the list puts them"));
            }
            if !(node.grant.is_finite() && node.grant >= 0.0 && node.seat.is_finite() && node.seat >= 0.0) {
                return Err(wrong("a node with credits that are not an amount"));
            }
        }
        Ok(())
    }

    fn check_links(&self) -> Result<()> {
        let n = self.nodes.len();
        let inside = |end: &End| !matches!(end, End::Node(at) if *at >= n);
        let fine = self.links.audiences.iter().all(|a| inside(&a.grantee) && inside(&a.grantor))
            && self.links.watchdogs.iter().all(|dog| dog.owner < n)
            && self.links.docket_refs.iter().all(|item| item.node < n);
        if !fine {
            return Err(wrong("its links name a node the file does not hold"));
        }
        Ok(())
    }

    /// The index's line for a part, when the file holds it.
    pub fn listed(&self, name: &str) -> Option<&IndexLine> {
        self.index.get(name).filter(|_| self.places.contains_key(name))
    }

    /// The name of one of a node's parts.
    pub fn of(&self, node: usize, part: &str) -> String {
        format!("{}/{part}", self.nodes[node].dir)
    }

    /// A small part, whole: `None` when the file has none.
    pub fn part(&mut self, name: &str, max: u64) -> Result<Option<Vec<u8>>> {
        let (Some(line), Some(at)) = (self.index.get(name), self.places.get(name)) else { return Ok(None) };
        let entry = self.zip.entries()[*at].clone();
        if entry.size != line.size {
            return Err(wrong(format!("{name} is not the size the file's index says")));
        }
        let bytes = self.zip.read_all(&entry, max).map_err(unreadable)?;
        if hex::encode(Sha256::digest(&bytes)) != line.sha256 {
            return Err(wrong(format!("{name} is not what the file's index says")));
        }
        Ok(Some(bytes))
    }

    /// A part written line by line, and how many records the index says it holds.
    pub fn lines(&mut self, name: &str) -> Result<Option<(Lines<'_>, Option<u64>)>> {
        let (Some(line), Some(at)) = (self.index.get(name), self.places.get(name)) else { return Ok(None) };
        let entry = self.zip.entries()[*at].clone();
        if entry.size != line.size {
            return Err(wrong(format!("{name} is not the size the file's index says")));
        }
        let (want, count) = (line.sha256.clone(), line.lines);
        let reader = std::io::BufReader::with_capacity(256 * 1024, self.zip.read(&entry).map_err(unreadable)?);
        Ok(Some((Lines { name: name.to_string(), reader, sha: Sha256::new(), want, buffer: Vec::new(), done: false }, count)))
    }

    /// How many records a part holds: what the index says, or a count of its lines.
    pub fn count(&mut self, name: &str) -> Result<u64> {
        let Some((mut lines, known)) = self.lines(name)? else { return Ok(0) };
        if let Some(known) = known {
            return Ok(known);
        }
        let mut n = 0;
        while lines.next()?.is_some() {
            n += 1;
        }
        Ok(n)
    }

    /// The files the index names under `folder`, each with its path inside it (`/` between
    /// plain parts) and its size, in the order of their names.
    pub fn files_under(&self, folder: &str) -> Vec<(String, String, u64)> {
        let prefix = format!("{folder}/");
        let mut out: Vec<(String, String, u64)> = self
            .index
            .iter()
            .filter(|(name, _)| name.starts_with(&prefix) && self.places.get(*name).is_some_and(|at| !self.zip.entries()[*at].folder))
            .map(|(name, line)| (name.clone(), name[prefix.len()..].to_string(), line.size))
            .collect();
        out.sort();
        out
    }

    /// The folders the zip itself names under `folder`, by their path inside it: an empty
    /// folder is a folder too.
    pub fn folders_under(&self, folder: &str) -> Vec<String> {
        let prefix = format!("{folder}/");
        let mut out: Vec<String> = self
            .zip
            .entries()
            .iter()
            .filter(|entry| entry.folder && entry.name.starts_with(&prefix) && entry.name.len() > prefix.len())
            .map(|entry| entry.name[prefix.len()..].trim_end_matches('/').to_string())
            .filter(|inner| super::names::safe_parts(inner).is_some())
            .collect();
        out.sort();
        out
    }

    /// Unpack the file part `name` to `dest`, which lies in a folder that exists. The bytes go
    /// to a file beside it first and take its place only when they read back as the index
    /// says. `each` hears of every piece written. Returns the bytes written.
    pub fn unpack(&mut self, name: &str, dest: &Path, each: &mut dyn FnMut(u64)) -> Result<u64> {
        let (Some(line), Some(at)) = (self.index.get(name), self.places.get(name)) else { return Err(wrong(format!("it has no {name}"))) };
        let entry = self.zip.entries()[*at].clone();
        if entry.link || entry.folder || entry.size != line.size {
            return Err(wrong(format!("{name} is not the file the index says")));
        }
        let want = line.sha256.clone();
        let beside = part_beside(dest);
        let mut guard = Unfinished(Some(beside.clone()));
        let mut reader = self.zip.read(&entry).map_err(unreadable)?;
        let mut file = std::io::BufWriter::with_capacity(256 * 1024, std::fs::File::create(&beside)?);
        let mut sha = Sha256::new();
        let mut chunk = vec![0u8; 256 * 1024];
        let mut written = 0u64;
        loop {
            let read = reader.read(&mut chunk).map_err(|error| wrong(format!("{name}: {error}")))?;
            if read == 0 {
                break;
            }
            sha.update(&chunk[..read]);
            file.write_all(&chunk[..read])?;
            written += read as u64;
            each(read as u64);
        }
        file.flush()?;
        drop(file);
        if hex::encode(sha.finalize()) != want {
            return Err(wrong(format!("{name} is not what the file's index says")));
        }
        std::fs::rename(&beside, dest)?;
        guard.0 = None;
        Ok(written)
    }
}

/// The file a part is written to before it takes its place: no export takes such a file
/// (`export::engine_owned`).
#[nolog]
fn part_beside(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".orgtree-part");
    dest.with_file_name(name)
}

struct Unfinished(Option<PathBuf>);

impl Drop for Unfinished {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::zipfile::ZipOut;

    /// A small export written as `export::run` writes one: the parts, the index, the manifest.
    pub(crate) fn write(path: &Path, nodes: &[Node], links: &Links, parts: &[(&str, &[u8], Option<u64>)], spoil: &dyn Fn(&mut Vec<(String, Vec<u8>)>, &mut Manifest)) {
        let mut all: Vec<(String, Vec<u8>, Option<u64>)> = vec![
            (format::NODES.into(), serde_json::to_vec(&Nodes { nodes: nodes.to_vec() }).unwrap(), None),
            (format::LINKS.into(), serde_json::to_vec(links).unwrap(), None),
        ];
        all.extend(parts.iter().map(|(name, bytes, lines)| (name.to_string(), bytes.to_vec(), *lines)));
        let mut index = Vec::new();
        for (name, bytes, lines) in &all {
            serde_json::to_writer(&mut index, &IndexLine { name: name.clone(), size: bytes.len() as u64, sha256: hex::encode(Sha256::digest(bytes)), lines: *lines }).unwrap();
            index.push(b'\n');
        }
        let mut manifest = Manifest { kind: format::KIND.into(), format: format::FORMAT, orgtree_version: "4.7.0".into(), exported_at: "2026-11-23T20:40:00Z".into(),
            root: nodes.first().map(|n| n.name.clone()).unwrap_or_default(), index_sha256: hex::encode(Sha256::digest(&index)), ..Manifest::default() };
        let mut files: Vec<(String, Vec<u8>)> = all.into_iter().map(|(name, bytes, _)| (name, bytes)).collect();
        files.push((format::INDEX.into(), index));
        spoil(&mut files, &mut manifest);
        files.push((format::MANIFEST.into(), serde_json::to_vec(&manifest).unwrap()));
        let mut out = Vec::new();
        {
            let mut sink = |bytes: Vec<u8>| {
                out.extend_from_slice(&bytes);
                true
            };
            let mut zip = ZipOut::new(&mut sink);
            assert!(zip.folder("nodes/0001-lead/scratch/empty", None));
            for (name, bytes) in &files {
                assert!(zip.file(name, None, &mut &bytes[..]).unwrap());
            }
            assert!(zip.finish());
        }
        std::fs::write(path, out).unwrap();
    }

    pub(crate) fn node(at: usize, name: &str, parent: Option<usize>) -> Node {
        Node { name: name.into(), parent, kind: "agent".into(), tier: "big".into(), dir: format::node_dir(at, name), ..Node::default() }
    }

    fn temp() -> PathBuf {
        let root = std::env::temp_dir().join(format!("orgtree-export-reader-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn refused(path: &Path) -> String {
        match Export::open(path) {
            Ok(_) => panic!("the file opened"),
            Err(error) => format!("{error:#}"),
        }
    }

    #[test]
    fn a_file_is_read_back_part_by_part_as_its_index_says() {
        let root = temp();
        let path = root.join("team.zip");
        let nodes = vec![node(0, "lead", None), node(1, "worker", Some(0))];
        let convo = b"{\"seq\":1}\n{\"seq\":2}\n";
        write(&path, &nodes, &Links::default(), &[
            ("nodes/0001-lead/convo.jsonl", convo, Some(2)),
            ("nodes/0001-lead/scratch/notes.md", b"hello", None),
            ("nodes/0001-lead/scratch/deep/a.txt", b"a", None),
            ("nodes/0002-worker/turns.jsonl", b"{\"n\":1}\n\n{\"n\":2}\n", None),
        ], &|_, _| {});
        let mut export = Export::open(&path).unwrap();
        assert_eq!(export.nodes.len(), 2);
        assert_eq!(export.of(1, format::TURNS), "nodes/0002-worker/turns.jsonl");
        // a part line by line, with the count the index gives, or a count of the lines when it gives none
        let (mut lines, known) = export.lines("nodes/0001-lead/convo.jsonl").unwrap().unwrap();
        assert_eq!(known, Some(2));
        assert_eq!(lines.next().unwrap().unwrap()["seq"], 1);
        assert_eq!(lines.next().unwrap().unwrap()["seq"], 2);
        assert!(lines.next().unwrap().is_none() && lines.next().unwrap().is_none());
        assert_eq!(export.count("nodes/0002-worker/turns.jsonl").unwrap(), 2);
        assert_eq!(export.count("nodes/0002-worker/convo.jsonl").unwrap(), 0);
        assert!(export.lines("nodes/0002-worker/convo.jsonl").unwrap().is_none());
        // the files of a folder, and the folders the zip names, an empty one too
        let files = export.files_under("nodes/0001-lead/scratch");
        assert_eq!(files.iter().map(|f| (f.1.as_str(), f.2)).collect::<Vec<_>>(), [("deep/a.txt", 1), ("notes.md", 5)]);
        assert_eq!(export.folders_under("nodes/0001-lead/scratch"), ["empty"]);
        assert!(export.files_under("nodes/0001-lead/scr").is_empty());
        // a file is unpacked beside its place first
        let dest = root.join("notes.md");
        let mut heard = 0;
        assert_eq!(export.unpack("nodes/0001-lead/scratch/notes.md", &dest, &mut |n| heard += n).unwrap(), 5);
        assert_eq!((std::fs::read(&dest).unwrap(), heard), (b"hello".to_vec(), 5));
        assert!(!part_beside(&dest).exists());
        assert!(export.unpack("nodes/0001-lead/scratch/none.md", &root.join("none.md"), &mut |_| {}).is_err());
        drop(export);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_file_that_is_not_what_it_says_is_refused_before_anything_is_made_of_it() {
        let root = temp();
        let path = root.join("team.zip");
        let nodes = vec![node(0, "lead", None), node(1, "worker", Some(0))];
        let none: &[(&str, &[u8], Option<u64>)] = &[];
        // not a zip at all
        std::fs::write(&path, b"plain text").unwrap();
        assert!(refused(&path).contains("not an export Orgtree can read"));
        // a zip that is no export, another kind of file, a newer format
        write(&path, &nodes, &Links::default(), none, &|files, _| files.retain(|(name, _)| name != format::INDEX));
        assert!(refused(&path).contains("it has no index.jsonl"));
        write(&path, &nodes, &Links::default(), none, &|_, manifest| manifest.kind = "orgtree-template".into());
        assert!(refused(&path).contains("does not call it an Orgtree export"));
        write(&path, &nodes, &Links::default(), none, &|_, manifest| {
            manifest.format = format::FORMAT + 1;
            manifest.orgtree_version = "9.0.0".into();
        });
        assert!(refused(&path).contains("made by a newer Orgtree (9.0.0)"));
        // an index that is not the manifest's, and a part that is not the index's
        write(&path, &nodes, &Links::default(), none, &|_, manifest| manifest.index_sha256 = "00".repeat(32));
        assert!(refused(&path).contains("its index is not the one its manifest names"));
        write(&path, &nodes, &Links::default(), none, &|files, _| files[0].1 = serde_json::to_vec(&Nodes { nodes: vec![node(0, "other", None), node(1, "worker", Some(0))] }).unwrap());
        assert!(refused(&path).contains("nodes.json is not"));
        // node lists no import can follow
        for (bad, why) in [
            (Vec::new(), "it holds no node"),
            (vec![node(0, "lead", None), node(1, "worker", None)], "not one tree"),
            (vec![node(0, "lead", None), node(1, "worker", Some(1))], "not one tree"),
            (vec![node(0, "lead", Some(0))], "not one tree"),
            (vec![node(0, "user", None)], "a name no node may have"),
            (vec![node(0, "a/b", None)], "a name no node may have"),
            (vec![Node { dir: "nodes/0001-lead/../../x".into(), ..node(0, "lead", None) }], "not where its place in the list puts them"),
            (vec![Node { kind: "robot".into(), ..node(0, "lead", None) }], "a kind this Orgtree does not know"),
            (vec![Node { grant: -1.0, ..node(0, "lead", None) }], "credits that are not an amount"),
        ] {
            write(&path, &bad, &Links::default(), none, &|_, _| {});
            let said = refused(&path);
            assert!(said.contains(why), "{why}: {said}");
        }
        // links to a node the file does not hold
        let links = Links { audiences: vec![format::Audience { grantee: End::Node(5), grantor: End::User }], ..Links::default() };
        write(&path, &nodes, &links, none, &|_, _| {});
        assert!(refused(&path).contains("its links name a node the file does not hold"));
        // a part changed after the index was written is found when it is read
        write(&path, &nodes, &Links::default(), &[("nodes/0001-lead/convo.jsonl", b"{\"seq\":1}\n", Some(1)), ("nodes/0001-lead/scratch/a.txt", b"abc", None)], &|files, _| {
            for (name, bytes) in files.iter_mut() {
                if name.ends_with("convo.jsonl") {
                    *bytes = b"{\"seq\":9}\n".to_vec();
                }
                if name.ends_with("a.txt") {
                    *bytes = b"abd".to_vec();
                }
            }
        });
        let mut export = Export::open(&path).unwrap();
        let (mut lines, _) = export.lines("nodes/0001-lead/convo.jsonl").unwrap().unwrap();
        assert_eq!(lines.next().unwrap().unwrap()["seq"], 9);
        assert!(format!("{:#}", lines.next().unwrap_err()).contains("not what the file's index says"));
        let dest = root.join("a.txt");
        assert!(format!("{:#}", export.unpack("nodes/0001-lead/scratch/a.txt", &dest, &mut |_| {}).unwrap_err()).contains("not what the file's index says"));
        assert!(!dest.exists() && !part_beside(&dest).exists());
        drop(export);
        // an index that names a place outside the file's folders
        write(&path, &nodes, &Links::default(), &[("../outside.txt", b"x", None)], &|_, _| {});
        assert!(refused(&path).contains("outside the file's own folders"));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
