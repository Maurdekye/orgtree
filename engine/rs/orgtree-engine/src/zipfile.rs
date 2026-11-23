//! Zip files, written as they are made and read entry by entry.
//!
//! `ZipOut` writes a zip to a sink without holding more of it than the names
//! and numbers of its entries: the scratch-files route sends a folder that
//! way, and an export of agents writes its file that way
//! (docs/rust-engine/agent-export.md). `ZipIn` (in `read`) reads a zip from a
//! file somebody else may have made: it trusts nothing the file says about
//! itself beyond what it checks.

use std::io::{Read, Write};

mod read;
#[cfg(test)]
mod tests;

pub use read::{EntryReader, Limits, ZipError, ZipIn};

/// Bytes read from a file at a time while it is deflated.
const CHUNK: usize = 64 * 1024;

/// One entry of the zip, as its central directory names it.
struct Zipped {
    name: String,
    folder: bool,
    crc: u32,
    packed: u64,
    size: u64,
    offset: u64,
    time: u16,
    date: u16,
}

/// MS-DOS time and date of a moment (UTC), as a zip keeps them. Before 1980: 1980-01-01.
#[nolog]
pub(crate) fn dos_time(modified: Option<std::time::SystemTime>) -> (u16, u16) {
    use chrono::{Datelike, Timelike};
    let Some(at) = modified.map(chrono::DateTime::<chrono::Utc>::from).filter(|at| (1980..=2107).contains(&at.year())) else {
        return (0, 0x21);
    };
    let time = (at.hour() << 11) | (at.minute() << 5) | (at.second() / 2);
    let date = ((at.year() as u32 - 1980) << 9) | (at.month() << 5) | at.day();
    (time as u16, date as u16)
}

/// What one written file came to: its size as it was read, and as it lies in the zip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Written {
    pub size: u64,
    pub packed: u64,
    pub crc: u32,
}

/// A file of the zip that is being written (`ZipOut::begin`).
pub struct Open {
    name: String,
    offset: u64,
    time: u16,
    date: u16,
    crc: flate2::Crc,
    deflate: flate2::write::DeflateEncoder<Vec<u8>>,
    size: u64,
    packed: u64,
}

/// A zip written as it is made: nothing of it is held but the names and numbers of its
/// entries. Every file is deflated and followed by its sizes (a data descriptor), and every
/// size and offset is kept in ZIP64 form, so neither a file nor the whole has a limit.
/// `sink` takes the next bytes and answers false when nobody is reading any more.
pub struct ZipOut<'a> {
    sink: &'a mut dyn FnMut(Vec<u8>) -> bool,
    at: u64,
    entries: Vec<Zipped>,
}

#[nolog]
impl<'a> ZipOut<'a> {
    pub fn new(sink: &'a mut dyn FnMut(Vec<u8>) -> bool) -> Self {
        ZipOut { sink, at: 0, entries: Vec::new() }
    }

    /// Bytes handed to the sink so far.
    pub fn written(&self) -> u64 {
        self.at
    }

    /// Entries written so far, folders included.
    pub fn count(&self) -> usize {
        self.entries.len()
    }

    /// False when the reader is gone: the caller stops.
    fn send(&mut self, bytes: Vec<u8>) -> bool {
        self.at += bytes.len() as u64;
        (self.sink)(bytes)
    }

    pub fn folder(&mut self, name: &str, modified: Option<std::time::SystemTime>) -> bool {
        let (time, date) = dos_time(modified);
        let name = format!("{name}/");
        let mut head = Vec::with_capacity(30 + name.len());
        head.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        for n in [20u16, 0x0800, 0, time, date] {
            head.extend_from_slice(&n.to_le_bytes());
        }
        head.extend_from_slice(&[0u8; 12]);
        head.extend_from_slice(&(name.len() as u16).to_le_bytes());
        head.extend_from_slice(&0u16.to_le_bytes());
        head.extend_from_slice(name.as_bytes());
        let offset = self.at;
        self.entries.push(Zipped { name, folder: true, crc: 0, packed: 0, size: 0, offset, time, date });
        self.send(head)
    }

    /// One file from `data`. `Ok(false)`: the reader is gone. An error is `data`'s: what was
    /// sent of this entry cannot be taken back, so the zip ends there, unfinished.
    pub fn file(&mut self, name: &str, modified: Option<std::time::SystemTime>, data: &mut dyn Read) -> std::io::Result<bool> {
        Ok(self.file_measured(name, modified, data)?.is_some())
    }

    /// `file`, answering what was written; `None` when the reader is gone.
    pub fn file_measured(&mut self, name: &str, modified: Option<std::time::SystemTime>, data: &mut dyn Read) -> std::io::Result<Option<Written>> {
        let Some(mut open) = self.begin(name, modified) else { return Ok(None) };
        let mut chunk = vec![0u8; CHUNK];
        loop {
            let read = data.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            if !self.put(&mut open, &chunk[..read])? {
                return Ok(None);
            }
        }
        self.end(open)
    }

    /// Start a file whose bytes come in pieces (`put`) and that `end` closes. `None` when the
    /// reader is gone. One file at a time: the next entry starts after `end`.
    pub fn begin(&mut self, name: &str, modified: Option<std::time::SystemTime>) -> Option<Open> {
        let (time, date) = dos_time(modified);
        let offset = self.at;
        let mut head = Vec::with_capacity(50 + name.len());
        head.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        // needs 4.5 (ZIP64); sizes follow the data (bit 3), the name is UTF-8 (bit 11); deflated
        for n in [45u16, 0x0808, 8, time, date] {
            head.extend_from_slice(&n.to_le_bytes());
        }
        head.extend_from_slice(&0u32.to_le_bytes());
        head.extend_from_slice(&u32::MAX.to_le_bytes());
        head.extend_from_slice(&u32::MAX.to_le_bytes());
        head.extend_from_slice(&(name.len() as u16).to_le_bytes());
        head.extend_from_slice(&20u16.to_le_bytes());
        head.extend_from_slice(name.as_bytes());
        // the ZIP64 field: it says the sizes that follow the data are 8 bytes each
        head.extend_from_slice(&1u16.to_le_bytes());
        head.extend_from_slice(&16u16.to_le_bytes());
        head.extend_from_slice(&[0u8; 16]);
        if !self.send(head) {
            return None;
        }
        Some(Open {
            name: name.to_string(), offset, time, date, crc: flate2::Crc::new(),
            deflate: flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast()), size: 0, packed: 0,
        })
    }

    /// The next bytes of the open file. `Ok(false)`: the reader is gone.
    pub fn put(&mut self, open: &mut Open, bytes: &[u8]) -> std::io::Result<bool> {
        open.crc.update(bytes);
        open.size += bytes.len() as u64;
        open.deflate.write_all(bytes)?;
        let out = std::mem::take(open.deflate.get_mut());
        if !out.is_empty() {
            open.packed += out.len() as u64;
            if !self.send(out) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Close the open file; `None` when the reader is gone.
    pub fn end(&mut self, open: Open) -> std::io::Result<Option<Written>> {
        let Open { name, offset, time, date, crc, deflate, size, mut packed } = open;
        let rest = deflate.finish()?;
        packed += rest.len() as u64;
        let mut tail = rest;
        tail.extend_from_slice(&0x0807_4b50u32.to_le_bytes());
        tail.extend_from_slice(&crc.sum().to_le_bytes());
        tail.extend_from_slice(&packed.to_le_bytes());
        tail.extend_from_slice(&size.to_le_bytes());
        self.entries.push(Zipped { name, folder: false, crc: crc.sum(), packed, size, offset, time, date });
        Ok(self.send(tail).then_some(Written { size, packed, crc: crc.sum() }))
    }

    /// The central directory and the end records.
    pub fn finish(mut self) -> bool {
        let start = self.at;
        let mut out = Vec::new();
        for entry in &self.entries {
            out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            let (flags, method) = if entry.folder { (0x0800u16, 0u16) } else { (0x0808, 8) };
            for n in [45u16, 45, flags, method, entry.time, entry.date] {
                out.extend_from_slice(&n.to_le_bytes());
            }
            out.extend_from_slice(&entry.crc.to_le_bytes());
            out.extend_from_slice(&u32::MAX.to_le_bytes());
            out.extend_from_slice(&u32::MAX.to_le_bytes());
            out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            out.extend_from_slice(&28u16.to_le_bytes());
            // no comment, disk 0, no internal attributes
            out.extend_from_slice(&[0u8; 6]);
            out.extend_from_slice(&(if entry.folder { 0x10u32 } else { 0 }).to_le_bytes());
            out.extend_from_slice(&u32::MAX.to_le_bytes());
            out.extend_from_slice(entry.name.as_bytes());
            out.extend_from_slice(&1u16.to_le_bytes());
            out.extend_from_slice(&24u16.to_le_bytes());
            for n in [entry.size, entry.packed, entry.offset] {
                out.extend_from_slice(&n.to_le_bytes());
            }
        }
        let (count, length) = (self.entries.len() as u64, out.len() as u64);
        // the ZIP64 end record, where it is, and the old end record that points at them
        out.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
        out.extend_from_slice(&44u64.to_le_bytes());
        for n in [45u16, 45] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 8]);
        for n in [count, count, length, start] {
            out.extend_from_slice(&n.to_le_bytes());
        }
        out.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(start + length).to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0u8; 4]);
        out.extend_from_slice(&[0xff; 12]);
        out.extend_from_slice(&0u16.to_le_bytes());
        self.send(out)
    }
}

/// Whether a zip can name an entry `name`: its header counts the name's bytes in 16 bits, and
/// a folder is named with a slash after it (review F-4, 2026-11-14).
#[nolog]
pub fn name_fits(name: &str, folder: bool) -> bool {
    name.len() + usize::from(folder) <= u16::MAX as usize
}
