//! Reading a zip somebody else may have made.
//!
//! The file is not trusted. `open` reads the end records and the central
//! directory and refuses what it cannot vouch for: a file with no end record
//! (cut short), more than one disk, an encrypted entry, an entry that lies
//! outside the file or over another one, more entries than the caller allows.
//! `read` hands out one entry's bytes and stops with an error the moment the
//! entry turns out to be larger than its directory record says, or when its
//! length or checksum differ at the end. Names are given as written: whether
//! a name may become a file is the caller's question.
//!
//! Stored and deflated entries are read, with or without ZIP64 records.

use std::io::{Read, Seek, SeekFrom};

/// Why a zip was refused.
#[derive(Debug)]
pub enum ZipError {
    /// It has no end record: not a zip, or cut short.
    NotAZip,
    /// A record points outside the file or contradicts another.
    Corrupt(&'static str),
    /// A zip feature this reader does not take.
    Unsupported(&'static str),
    /// More entries, or a larger directory, than the caller allows.
    TooLarge(&'static str),
    Io(std::io::Error),
}

impl std::fmt::Display for ZipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ZipError::NotAZip => f.write_str("this is not a complete zip file"),
            ZipError::Corrupt(why) => write!(f, "the zip file is damaged: {why}"),
            ZipError::Unsupported(what) => write!(f, "the zip file uses {what}, which is not read"),
            ZipError::TooLarge(what) => write!(f, "the zip file has {what}"),
            ZipError::Io(error) => write!(f, "the zip file could not be read: {error}"),
        }
    }
}

impl std::error::Error for ZipError {}

impl From<std::io::Error> for ZipError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::UnexpectedEof { ZipError::Corrupt("a record ends past the file") } else { ZipError::Io(error) }
    }
}

/// What `open` allows.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub entries: u64,
    pub directory_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { entries: 2_000_000, directory_bytes: 512 * 1024 * 1024 }
    }
}

/// One entry, as the central directory names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// As written, `/` between its parts; a folder's name ends with `/`.
    pub name: String,
    pub folder: bool,
    /// A symbolic link, by the Unix mode a zip may carry: its content is the link's target.
    pub link: bool,
    pub size: u64,
    pub packed: u64,
    pub crc: u32,
    method: u16,
    offset: u64,
}

const END: u32 = 0x0605_4b50;
const END64: u32 = 0x0606_4b50;
const LOCATOR64: u32 = 0x0706_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;

#[nolog]
fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

#[nolog]
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

#[nolog]
fn u64_at(bytes: &[u8], at: usize) -> u64 {
    let mut eight = [0u8; 8];
    eight.copy_from_slice(&bytes[at..at + 8]);
    u64::from_le_bytes(eight)
}

/// A zip opened for reading.
pub struct ZipIn {
    file: std::fs::File,
    entries: Vec<Entry>,
    /// Where the central directory starts: no entry's bytes reach past it.
    directory: u64,
}

#[nolog]
impl ZipIn {
    pub fn open(path: &std::path::Path, limits: Limits) -> Result<ZipIn, ZipError> {
        let mut file = std::fs::File::open(path)?;
        let length = file.metadata()?.len();
        // the end record: 22 bytes and a comment of at most 65535, the last thing in the file
        let tail_length = length.min(22 + 65_535);
        if tail_length < 22 {
            return Err(ZipError::NotAZip);
        }
        let mut tail = vec![0u8; tail_length as usize];
        file.seek(SeekFrom::Start(length - tail_length))?;
        file.read_exact(&mut tail)?;
        let end = (0..=tail.len() - 22)
            .rev()
            .find(|at| u32_at(&tail, *at) == END && *at + 22 + u16_at(&tail, *at + 20) as usize == tail.len())
            .ok_or(ZipError::NotAZip)?;
        let end_at = length - tail_length + end as u64;
        if u16_at(&tail, end + 4) != 0 && u16_at(&tail, end + 4) != u16::MAX || u16_at(&tail, end + 6) != 0 && u16_at(&tail, end + 6) != u16::MAX {
            return Err(ZipError::Unsupported("more than one disk"));
        }
        let (mut count, mut size, mut start) =
            (u16_at(&tail, end + 10) as u64, u32_at(&tail, end + 12) as u64, u32_at(&tail, end + 16) as u64);
        let wide = count == u16::MAX as u64 || size == u32::MAX as u64 || start == u32::MAX as u64;
        if wide {
            // the ZIP64 locator lies right before the end record and says where the ZIP64 end record is
            if end_at < 20 {
                return Err(ZipError::Corrupt("its ZIP64 records are missing"));
            }
            let mut locator = [0u8; 20];
            file.seek(SeekFrom::Start(end_at - 20))?;
            file.read_exact(&mut locator)?;
            if u32_at(&locator, 0) != LOCATOR64 {
                return Err(ZipError::Corrupt("its ZIP64 records are missing"));
            }
            if u32_at(&locator, 4) != 0 || u32_at(&locator, 16) > 1 {
                return Err(ZipError::Unsupported("more than one disk"));
            }
            let at = u64_at(&locator, 8);
            if at.checked_add(56).is_none_or(|last| last > end_at - 20) {
                return Err(ZipError::Corrupt("its ZIP64 end record is outside the file"));
            }
            let mut wide_end = [0u8; 56];
            file.seek(SeekFrom::Start(at))?;
            file.read_exact(&mut wide_end)?;
            if u32_at(&wide_end, 0) != END64 {
                return Err(ZipError::Corrupt("its ZIP64 end record is not where it says"));
            }
            if u32_at(&wide_end, 16) != 0 || u32_at(&wide_end, 20) != 0 {
                return Err(ZipError::Unsupported("more than one disk"));
            }
            (count, size, start) = (u64_at(&wide_end, 32), u64_at(&wide_end, 40), u64_at(&wide_end, 48));
        }
        if count > limits.entries {
            return Err(ZipError::TooLarge("too many entries"));
        }
        if size > limits.directory_bytes {
            return Err(ZipError::TooLarge("too large a directory"));
        }
        if start.checked_add(size).is_none_or(|last| last > end_at) {
            return Err(ZipError::Corrupt("its directory is outside the file"));
        }
        let mut directory = vec![0u8; size as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut directory)?;
        let mut entries = Vec::with_capacity(count.min(1 << 16) as usize);
        let mut at = 0usize;
        for _ in 0..count {
            if directory.len() < at + 46 || u32_at(&directory, at) != CENTRAL {
                return Err(ZipError::Corrupt("its directory ends early"));
            }
            let made_by = u16_at(&directory, at + 4);
            let flags = u16_at(&directory, at + 8);
            let method = u16_at(&directory, at + 10);
            let crc = u32_at(&directory, at + 16);
            let (mut packed, mut size) = (u32_at(&directory, at + 20) as u64, u32_at(&directory, at + 24) as u64);
            let (name_length, extra_length, comment_length) =
                (u16_at(&directory, at + 28) as usize, u16_at(&directory, at + 30) as usize, u16_at(&directory, at + 32) as usize);
            let disk = u16_at(&directory, at + 34);
            let attributes = u32_at(&directory, at + 38);
            let mut offset = u32_at(&directory, at + 42) as u64;
            let name_at = at + 46;
            let extra_at = name_at + name_length;
            let next = extra_at + extra_length + comment_length;
            if directory.len() < next {
                return Err(ZipError::Corrupt("its directory ends early"));
            }
            let name = std::str::from_utf8(&directory[name_at..extra_at]).map_err(|_| ZipError::Unsupported("a name that is not UTF-8"))?.to_string();
            // the ZIP64 field carries, in this order, whichever of the three the record left at its maximum
            let mut extra = &directory[extra_at..extra_at + extra_length];
            while extra.len() >= 4 {
                let (id, length) = (u16_at(extra, 0), u16_at(extra, 2) as usize);
                if extra.len() < 4 + length {
                    return Err(ZipError::Corrupt("an entry's extra field ends early"));
                }
                if id == 1 {
                    let mut field = &extra[4..4 + length];
                    for value in [&mut size, &mut packed, &mut offset] {
                        if *value == u32::MAX as u64 {
                            if field.len() < 8 {
                                return Err(ZipError::Corrupt("an entry's ZIP64 field is too short"));
                            }
                            *value = u64_at(field, 0);
                            field = &field[8..];
                        }
                    }
                }
                extra = &extra[4 + length..];
            }
            if flags & 1 != 0 {
                return Err(ZipError::Unsupported("encryption"));
            }
            if disk != 0 && disk != u16::MAX {
                return Err(ZipError::Unsupported("more than one disk"));
            }
            if method != 0 && method != 8 {
                return Err(ZipError::Unsupported("a compression other than deflate"));
            }
            if method == 0 && packed != size {
                return Err(ZipError::Corrupt("a stored entry's two sizes differ"));
            }
            // header, name and data all lie before the directory
            if offset.checked_add(30 + name_length as u64).and_then(|data| data.checked_add(packed)).is_none_or(|last| last > start) {
                return Err(ZipError::Corrupt("an entry lies outside the file"));
            }
            let folder = name.ends_with('/');
            // made on Unix (the high byte is 3): the mode is in the high half of the attributes
            let link = made_by >> 8 == 3 && (attributes >> 16) & 0o170000 == 0o120000;
            entries.push(Entry { name, folder, link, size, packed, crc, method, offset });
            at = next;
        }
        // no entry's bytes may lie over another's: a small file must not stand for many large ones
        let mut order: Vec<(u64, u64)> = entries.iter().map(|e| (e.offset, e.offset + 30 + e.name.len() as u64 + e.packed)).collect();
        order.sort_unstable();
        if order.windows(2).any(|pair| pair[1].0 < pair[0].1) {
            return Err(ZipError::Corrupt("two entries lie over each other"));
        }
        Ok(ZipIn { file, entries, directory: start })
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn find(&self, name: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.name == name)
    }

    /// The entry's bytes, as a reader that fails when they are not what the directory says.
    pub fn read(&mut self, entry: &Entry) -> Result<EntryReader<'_>, ZipError> {
        let mut head = [0u8; 30];
        self.file.seek(SeekFrom::Start(entry.offset))?;
        self.file.read_exact(&mut head)?;
        if u32_at(&head, 0) != LOCAL {
            return Err(ZipError::Corrupt("an entry is not where the directory says"));
        }
        if u16_at(&head, 6) & 1 != 0 {
            return Err(ZipError::Unsupported("encryption"));
        }
        if u16_at(&head, 8) != entry.method {
            return Err(ZipError::Corrupt("an entry and the directory disagree on its compression"));
        }
        let (name_length, extra_length) = (u16_at(&head, 26) as usize, u16_at(&head, 28) as u64);
        let mut name = vec![0u8; name_length];
        self.file.read_exact(&mut name)?;
        if name != entry.name.as_bytes() {
            return Err(ZipError::Corrupt("an entry and the directory disagree on its name"));
        }
        let data = entry.offset + 30 + name_length as u64 + extra_length;
        if data.checked_add(entry.packed).is_none_or(|last| last > self.directory) {
            return Err(ZipError::Corrupt("an entry lies outside the file"));
        }
        self.file.seek(SeekFrom::Start(data))?;
        let packed = (&mut self.file).take(entry.packed);
        let inner = if entry.method == 8 {
            Inner::Deflated(Box::new(flate2::read::DeflateDecoder::new(std::io::BufReader::with_capacity(64 * 1024, packed))))
        } else {
            Inner::Stored(packed)
        };
        Ok(EntryReader { inner, left: entry.size, crc: flate2::Crc::new(), want: entry.crc, done: false })
    }

    /// A small entry whole; refused when it says it is larger than `max`.
    pub fn read_all(&mut self, entry: &Entry, max: u64) -> Result<Vec<u8>, ZipError> {
        if entry.size > max {
            return Err(ZipError::TooLarge("a part larger than it may be"));
        }
        let mut out = Vec::with_capacity(entry.size as usize);
        self.read(entry)?.read_to_end(&mut out)?;
        Ok(out)
    }
}

enum Inner<'a> {
    Stored(std::io::Take<&'a mut std::fs::File>),
    Deflated(Box<flate2::read::DeflateDecoder<std::io::BufReader<std::io::Take<&'a mut std::fs::File>>>>),
}

/// One entry's bytes. Reading ends with an error when the entry holds more than its record
/// says, and at its end when it holds less or its checksum differs.
pub struct EntryReader<'a> {
    inner: Inner<'a>,
    left: u64,
    crc: flate2::Crc,
    want: u32,
    done: bool,
}

#[nolog]
fn bad(why: &'static str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, why)
}

impl Read for EntryReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.done || buffer.is_empty() {
            return Ok(0);
        }
        // one byte more than is left may be asked for: it is how a longer entry shows
        let most = (self.left.saturating_add(1)).min(buffer.len() as u64) as usize;
        let read = match &mut self.inner {
            Inner::Stored(stored) => stored.read(&mut buffer[..most])?,
            Inner::Deflated(deflated) => deflated.read(&mut buffer[..most])?,
        };
        if read as u64 > self.left {
            return Err(bad("an entry of the zip is larger than the zip says"));
        }
        if read == 0 {
            if self.left != 0 {
                return Err(bad("an entry of the zip is shorter than the zip says"));
            }
            if self.crc.sum() != self.want {
                return Err(bad("an entry of the zip does not match its checksum"));
            }
            self.done = true;
            return Ok(0);
        }
        self.left -= read as u64;
        self.crc.update(&buffer[..read]);
        Ok(read)
    }
}
