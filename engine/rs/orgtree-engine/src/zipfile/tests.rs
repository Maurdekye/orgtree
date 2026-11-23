use std::io::Read;
use std::path::PathBuf;

use super::*;

/// A file in the system's temporary folder, removed when the test ends.
struct Temp(PathBuf);

impl Temp {
    fn with(bytes: &[u8]) -> Temp {
        let path = std::env::temp_dir().join(format!("orgtree-zipfile-{}.zip", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        Temp(path)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        assert!(self.0.file_name().unwrap().to_string_lossy().starts_with("orgtree-zipfile-"));
        let _ = std::fs::remove_file(&self.0);
    }
}

/// What `ZipOut` makes of these files and folders.
fn written(parts: &[(&str, Option<&[u8]>)]) -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut sink = |chunk: Vec<u8>| {
            bytes.extend_from_slice(&chunk);
            true
        };
        let mut zip = ZipOut::new(&mut sink);
        for (name, data) in parts {
            match data {
                Some(data) => {
                    let mut data: &[u8] = data;
                    assert!(zip.file(name, None, &mut data).unwrap())
                }
                None => assert!(zip.folder(name, None)),
            }
        }
        assert!(zip.finish());
    }
    bytes
}

fn read_entry(zip: &mut ZipIn, name: &str) -> std::io::Result<Vec<u8>> {
    let entry = zip.find(name).expect("the entry is listed").clone();
    let mut out = Vec::new();
    zip.read(&entry).map_err(|e| std::io::Error::other(e.to_string()))?.read_to_end(&mut out)?;
    Ok(out)
}

/// One entry of a hand-made zip in the old (not ZIP64) form.
#[derive(Clone)]
struct Old {
    name: Vec<u8>,
    data: Vec<u8>,
    /// What the records say, where a test makes them lie.
    said_size: Option<u32>,
    said_crc: Option<u32>,
    flags: u16,
    local_name: Option<Vec<u8>>,
    deflate: bool,
    /// The Unix mode, when the entry says it was made on Unix.
    unix_mode: Option<u32>,
    /// Where the directory says the entry is, when a test moves it.
    said_offset: Option<u32>,
}

impl Old {
    fn new(name: &str, data: &[u8]) -> Old {
        Old { name: name.as_bytes().to_vec(), data: data.to_vec(), said_size: None, said_crc: None, flags: 0x0800, local_name: None, deflate: false, unix_mode: None, said_offset: None }
    }
}

fn crc_of(data: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(data);
    crc.sum()
}

/// A zip in the old form from `entries`, with `said_count` entries announced in its end record.
fn old_zip(entries: &[Old], said_count: Option<u16>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for entry in entries {
        let body = if entry.deflate {
            let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
            std::io::Write::write_all(&mut enc, &entry.data).unwrap();
            enc.finish().unwrap()
        } else {
            entry.data.clone()
        };
        let method: u16 = if entry.deflate { 8 } else { 0 };
        let size = entry.said_size.unwrap_or(entry.data.len() as u32);
        let crc = entry.said_crc.unwrap_or_else(|| crc_of(&entry.data));
        let offset = out.len() as u32;
        let local_name = entry.local_name.clone().unwrap_or_else(|| entry.name.clone());
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        for n in [20u16, entry.flags, method, 0, 0x21] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        for n in [crc, body.len() as u32, size] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        out.extend_from_slice(&(local_name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&local_name);
        out.extend_from_slice(&body);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        let made_by: u16 = if entry.unix_mode.is_some() { 3 << 8 | 20 } else { 20 };
        for n in [made_by, 20, entry.flags, method, 0, 0x21] {
            central.extend_from_slice(&n.to_le_bytes());
        }
        for n in [crc, body.len() as u32, size] {
            central.extend_from_slice(&n.to_le_bytes());
        }
        central.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 8]);
        central.extend_from_slice(&(entry.unix_mode.unwrap_or(0) << 16).to_le_bytes());
        central.extend_from_slice(&entry.said_offset.unwrap_or(offset).to_le_bytes());
        central.extend_from_slice(&entry.name);
    }
    let start = out.len() as u32;
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    let count = said_count.unwrap_or(entries.len() as u16);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn open(bytes: &[u8]) -> Result<(ZipIn, Temp), ZipError> {
    let temp = Temp::with(bytes);
    ZipIn::open(&temp.0, Limits::default()).map(|zip| (zip, temp))
}

#[test]
fn what_the_writer_writes_the_reader_reads_back() {
    let large: Vec<u8> = (0..300_000u32).flat_map(|n| (n % 251).to_le_bytes()).collect();
    let noise: Vec<u8> = (0..70_000u32).map(|n| (n.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let bytes = written(&[
        ("team", None),
        ("team/notes.txt", Some(b"hello\r\nworld")),
        ("team/empty", Some(b"")),
        ("team/deep/\u{e9}t\u{e9}.bin", Some(&noise)),
        ("large.dat", Some(&large)),
    ]);
    let (mut zip, _temp) = open(&bytes).unwrap();
    let names: Vec<(&str, bool, u64)> = zip.entries().iter().map(|e| (e.name.as_str(), e.folder, e.size)).collect();
    assert_eq!(names, [
        ("team/", true, 0),
        ("team/notes.txt", false, 12),
        ("team/empty", false, 0),
        ("team/deep/\u{e9}t\u{e9}.bin", false, 70_000),
        ("large.dat", false, 1_200_000),
    ]);
    assert!(zip.entries().iter().all(|e| !e.link));
    assert_eq!(read_entry(&mut zip, "team/notes.txt").unwrap(), b"hello\r\nworld");
    assert_eq!(read_entry(&mut zip, "team/empty").unwrap(), b"");
    assert_eq!(read_entry(&mut zip, "team/deep/\u{e9}t\u{e9}.bin").unwrap(), noise);
    assert_eq!(read_entry(&mut zip, "large.dat").unwrap(), large);
    // the large file went in smaller than it is
    assert!(zip.find("large.dat").unwrap().packed < 1_200_000);
}

#[test]
fn the_writer_says_what_each_file_came_to() {
    let mut bytes = Vec::new();
    let mut sink = |chunk: Vec<u8>| {
        bytes.extend_from_slice(&chunk);
        true
    };
    let mut zip = ZipOut::new(&mut sink);
    let got = zip.file_measured("a.txt", None, &mut &b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"[..]).unwrap().unwrap();
    assert_eq!((got.size, got.crc), (48, crc_of(&[b'a'; 48])));
    assert!(got.packed < 48);
    assert_eq!(zip.count(), 1);
    assert!(zip.written() > 0);
}

#[test]
fn a_file_written_in_pieces_reads_back_whole() {
    let mut bytes = Vec::new();
    {
        let mut sink = |chunk: Vec<u8>| {
            bytes.extend_from_slice(&chunk);
            true
        };
        let mut zip = ZipOut::new(&mut sink);
        let mut open = zip.begin("rows.jsonl", None).unwrap();
        for n in 0..5000u32 {
            assert!(zip.put(&mut open, format!("{{\"seq\":{n}}}
").as_bytes()).unwrap());
        }
        let got = zip.end(open).unwrap().unwrap();
        assert!(got.size > 50_000 && got.packed < got.size);
        // an empty one, then a whole one after it
        let empty = zip.begin("empty", None).unwrap();
        assert_eq!(zip.end(empty).unwrap().unwrap().size, 0);
        assert!(zip.file("after.txt", None, &mut &b"after"[..]).unwrap());
        assert!(zip.finish());
    }
    let (mut zip, _temp) = open(&bytes).unwrap();
    let rows = String::from_utf8(read_entry(&mut zip, "rows.jsonl").unwrap()).unwrap();
    assert_eq!(rows.lines().count(), 5000);
    assert_eq!(rows.lines().last(), Some("{\"seq\":4999}"));
    assert_eq!(read_entry(&mut zip, "empty").unwrap(), b"");
    assert_eq!(read_entry(&mut zip, "after.txt").unwrap(), b"after");
}

#[test]
fn an_ordinary_zip_in_the_old_form_is_read_stored_and_deflated() {
    let mut deflated = Old::new("b.txt", &[b'b'; 5000]);
    deflated.deflate = true;
    let (mut zip, _temp) = open(&old_zip(&[Old::new("a.txt", b"plain"), deflated, Old::new("folder/", b"")], None)).unwrap();
    assert_eq!(zip.entries().len(), 3);
    assert_eq!(read_entry(&mut zip, "a.txt").unwrap(), b"plain");
    assert_eq!(read_entry(&mut zip, "b.txt").unwrap(), vec![b'b'; 5000]);
    assert!(zip.find("folder/").unwrap().folder);
    let small = zip.find("a.txt").unwrap().clone();
    assert_eq!(zip.read_all(&small, 5).unwrap(), b"plain");
    assert!(matches!(zip.read_all(&small, 4), Err(ZipError::TooLarge(_))));
}

#[test]
fn a_file_that_is_not_a_whole_zip_is_refused() {
    assert!(matches!(open(b""), Err(ZipError::NotAZip)));
    assert!(matches!(open(b"this is some text, as long as an end record would be"), Err(ZipError::NotAZip)));
    let whole = written(&[("a.txt", Some(b"some text"))]);
    // cut anywhere before its end, it has no end record left
    for keep in [whole.len() - 1, whole.len() - 22, whole.len() / 2, 10] {
        assert!(open(&whole[..keep]).is_err(), "cut to {keep} bytes");
    }
    // bytes after the end record are not part of a zip
    let mut longer = whole.clone();
    longer.extend_from_slice(b"more");
    assert!(matches!(open(&longer), Err(ZipError::NotAZip)));
}

#[test]
fn an_entry_larger_than_its_record_says_stops_the_read() {
    // 100 000 bytes that the record calls 10: the read must end at the eleventh, not fill a disk
    let mut lying = Old::new("bomb.bin", &vec![0u8; 100_000]);
    lying.deflate = true;
    lying.said_size = Some(10);
    let (mut zip, _temp) = open(&old_zip(&[lying], None)).unwrap();
    let entry = zip.entries()[0].clone();
    assert_eq!(entry.size, 10);
    let mut out = Vec::new();
    let error = zip.read(&entry).unwrap().read_to_end(&mut out).unwrap_err();
    assert!(error.to_string().contains("larger than the zip says"), "{error}");
    assert!(out.len() <= 10, "{} bytes were handed out", out.len());
}

#[test]
fn an_entry_shorter_than_its_record_or_with_another_checksum_fails_at_its_end() {
    let mut short = Old::new("short.bin", b"abc");
    short.deflate = true;
    short.said_size = Some(9);
    let mut wrong = Old::new("wrong.bin", b"abcdef");
    wrong.said_crc = Some(1);
    let (mut zip, _temp) = open(&old_zip(&[short, wrong], None)).unwrap();
    assert!(read_entry(&mut zip, "short.bin").unwrap_err().to_string().contains("shorter than the zip says"));
    assert!(read_entry(&mut zip, "wrong.bin").unwrap_err().to_string().contains("checksum"));
}

#[test]
fn records_that_point_outside_the_file_or_over_each_other_are_refused() {
    let mut outside = Old::new("a.txt", b"abc");
    outside.said_offset = Some(900_000);
    assert!(matches!(open(&old_zip(&[outside], None)), Err(ZipError::Corrupt(_))));
    // two names for the same bytes
    let first = Old::new("a.txt", &[b'a'; 400]);
    let mut second = Old::new("b.txt", &[b'a'; 400]);
    second.said_offset = Some(0);
    second.name = b"a.txt".to_vec();
    assert!(matches!(open(&old_zip(&[first, second], None)), Err(ZipError::Corrupt("two entries lie over each other"))));
    // more entries announced than the directory holds
    assert!(matches!(open(&old_zip(&[Old::new("a.txt", b"abc")], Some(3))), Err(ZipError::Corrupt(_))));
}

#[test]
fn an_entry_named_otherwise_where_it_lies_is_refused_when_read() {
    let mut renamed = Old::new("notes.txt", b"abc");
    renamed.local_name = Some(b"other.txt".to_vec());
    let (mut zip, _temp) = open(&old_zip(&[renamed], None)).unwrap();
    let entry = zip.entries()[0].clone();
    assert!(matches!(zip.read(&entry), Err(ZipError::Corrupt("an entry and the directory disagree on its name"))));
}

#[test]
fn encryption_other_compression_and_other_name_encodings_are_not_read() {
    let mut encrypted = Old::new("a.txt", b"abc");
    encrypted.flags = 0x0801;
    assert!(matches!(open(&old_zip(&[encrypted], None)), Err(ZipError::Unsupported("encryption"))));
    let mut latin = Old::new("a.txt", b"abc");
    latin.name = vec![b'a', 0xe9, b'.', b't'];
    assert!(matches!(open(&old_zip(&[latin], None)), Err(ZipError::Unsupported(_))));
    // method 12 (bzip2) in both records
    let mut bytes = old_zip(&[Old::new("a.txt", b"abc")], None);
    let central = bytes.windows(4).position(|w| w == 0x0201_4b50u32.to_le_bytes()).unwrap();
    bytes[central + 10] = 12;
    assert!(matches!(open(&bytes), Err(ZipError::Unsupported(_))));
}

#[test]
fn a_link_is_named_as_a_link() {
    let mut link = Old::new("escape", b"/etc/passwd");
    link.unix_mode = Some(0o120777);
    let mut file = Old::new("plain", b"abc");
    file.unix_mode = Some(0o100644);
    let (zip, _temp) = open(&old_zip(&[link, file], None)).unwrap();
    assert!(zip.find("escape").unwrap().link);
    assert!(!zip.find("plain").unwrap().link);
}

#[test]
fn more_entries_than_allowed_are_refused_before_any_is_read() {
    let bytes = written(&[("a", Some(b"1")), ("b", Some(b"2")), ("c", Some(b"3"))]);
    let temp = Temp::with(&bytes);
    assert!(matches!(ZipIn::open(&temp.0, Limits { entries: 2, ..Limits::default() }), Err(ZipError::TooLarge("too many entries"))));
    assert!(matches!(ZipIn::open(&temp.0, Limits { directory_bytes: 10, ..Limits::default() }), Err(ZipError::TooLarge("too large a directory"))));
    assert!(ZipIn::open(&temp.0, Limits { entries: 3, ..Limits::default() }).is_ok());
}

#[test]
fn a_name_fits_when_the_header_can_count_it() {
    assert!(name_fits(&"n".repeat(65_535), false));
    assert!(!name_fits(&"n".repeat(65_535), true));
    assert!(!name_fits(&"n".repeat(65_536), false));
}
