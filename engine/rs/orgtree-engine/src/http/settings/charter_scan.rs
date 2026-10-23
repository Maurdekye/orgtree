//! Read-only charter discovery, separate from recursive skill-bundle import.
//! No charter text is logged. Bounds apply before opening/decoding contents.
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

pub(super) const FILE_MAX: u64 = 1_000_000;
pub(super) const DIR_MAX: usize = 500;

pub(super) struct Text {
    pub shown: String,
    pub chars: usize,
}

pub(super) struct Record {
    pub file: String,
    pub path: PathBuf,
    pub text: Option<Text>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    Missing,
    NotDirectory,
    Link,
    Invalid,
    Unreadable,
    NotFile,
    Oversize,
}

#[nolog]
fn io_refusal(error: io::Error) -> Refusal {
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ELOOP) {
        return Refusal::Link;
    }
    match error.kind() {
        io::ErrorKind::NotFound => Refusal::Missing,
        io::ErrorKind::InvalidInput => Refusal::Invalid,
        io::ErrorKind::NotADirectory => Refusal::NotDirectory,
        _ if cfg!(windows) && error.raw_os_error() == Some(123) => Refusal::Invalid,
        _ => Refusal::Unreadable,
    }
}

// OFFLINE, RECALL_ON_OPEN and RECALL_ON_DATA_ACCESS can require hydration even
// without a symlink type. Any reparse point is refused, including cloud ones.
#[nolog]
fn unsafe_attributes(attributes: u32) -> bool {
    attributes & (0x400 | 0x1000 | 0x40000 | 0x400000) != 0
}

#[nolog]
fn plain(meta: &Metadata) -> Result<(), Refusal> {
    #[cfg(windows)]
    let attributes = std::os::windows::fs::MetadataExt::file_attributes(meta);
    #[cfg(not(windows))]
    let attributes = 0;
    if meta.file_type().is_symlink() || unsafe_attributes(attributes) {
        Err(Refusal::Link)
    } else {
        Ok(())
    }
}

/// Hold every directory component open. On Windows the handles deny delete
/// sharing, so a checked ancestor cannot be replaced by a junction mid-read.
struct Directory {
    path: PathBuf,
    handles: Vec<File>,
}

#[nolog]
fn checked_path(path: &Path) -> Result<PathBuf, Refusal> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(Refusal::Invalid);
    }
    Ok(path.to_path_buf())
}

#[nolog]
fn open_directory(path: &Path) -> Result<Directory, Refusal> {
    let path = checked_path(path)?;
    let mut handles: Vec<File> = Vec::new();
    for part in path
        .ancestors()
        .filter(|p| !p.as_os_str().is_empty())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let meta = fs::symlink_metadata(part).map_err(io_refusal)?;
        plain(&meta)?;
        if !meta.is_dir() {
            return Err(Refusal::NotDirectory);
        }
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_NO_RECALL, FILE_FLAG_OPEN_REPARSE_POINT,
                FILE_SHARE_READ, FILE_SHARE_WRITE,
            };
            OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(
                    FILE_FLAG_BACKUP_SEMANTICS
                        | FILE_FLAG_OPEN_REPARSE_POINT
                        | FILE_FLAG_OPEN_NO_RECALL,
                )
                .open(part)
                .map_err(io_refusal)?
        };
        #[cfg(unix)]
        let file = {
            use std::ffi::CString;
            use std::os::fd::{AsRawFd, FromRawFd};
            use std::os::unix::ffi::OsStrExt;
            use std::os::unix::fs::OpenOptionsExt;
            if let Some(parent) = handles.last() {
                let name = CString::new(part.file_name().ok_or(Refusal::Invalid)?.as_bytes())
                    .map_err(|_| Refusal::Invalid)?;
                let fd = unsafe {
                    libc::openat(
                        parent.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY
                            | libc::O_NOFOLLOW
                            | libc::O_DIRECTORY
                            | libc::O_NONBLOCK
                            | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(io_refusal(io::Error::last_os_error()));
                }
                unsafe { File::from_raw_fd(fd) }
            } else {
                OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK)
                    .open(part)
                    .map_err(io_refusal)?
            }
        };
        #[cfg(not(any(windows, unix)))]
        let file = File::open(part).map_err(io_refusal)?;
        let opened = file.metadata().map_err(io_refusal)?;
        plain(&opened)?;
        if !opened.is_dir() {
            return Err(Refusal::NotDirectory);
        }
        handles.push(file);
    }
    Ok(Directory { path, handles })
}

#[nolog]
fn listing_path(directory: &Directory) -> PathBuf {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let fd = directory.handles.last().unwrap().as_raw_fd();
        // These are our live descriptors, never a user-supplied symlink path.
        let base = if cfg!(target_os = "linux") {
            "/proc/self/fd"
        } else {
            "/dev/fd"
        };
        PathBuf::from(base).join(fd.to_string())
    }
    #[cfg(not(unix))]
    {
        directory.path.clone()
    }
}

#[nolog]
fn metadata(directory: &Directory, name: &std::ffi::OsStr) -> Result<Metadata, Refusal> {
    let meta = fs::symlink_metadata(listing_path(directory).join(name)).map_err(io_refusal)?;
    plain(&meta)?;
    if !meta.is_file() {
        return Err(Refusal::NotFile);
    }
    if meta.len() > FILE_MAX {
        return Err(Refusal::Oversize);
    }
    Ok(meta)
}

#[nolog]
fn open_file(directory: &Directory, name: &std::ffi::OsStr) -> Result<File, Refusal> {
    // Check size/placeholder metadata BEFORE any content-capable open.
    metadata(directory, name)?;
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_NO_RECALL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OPEN_NO_RECALL)
            .open(directory.path.join(name))
            .map_err(io_refusal)?
    };
    #[cfg(unix)]
    let file = {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        let name = CString::new(name.as_bytes()).map_err(|_| Refusal::Invalid)?;
        let parent = directory.handles.last().ok_or(Refusal::Invalid)?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io_refusal(io::Error::last_os_error()));
        }
        unsafe { File::from_raw_fd(fd) }
    };
    #[cfg(not(any(windows, unix)))]
    let file = File::open(directory.path.join(name)).map_err(io_refusal)?;
    let opened = file.metadata().map_err(io_refusal)?;
    plain(&opened)?;
    if !opened.is_file() {
        return Err(Refusal::NotFile);
    }
    if opened.len() > FILE_MAX {
        return Err(Refusal::Oversize);
    }
    Ok(file)
}

#[nolog]
fn bounded_text(input: impl Read) -> Result<String, Refusal> {
    let mut bytes = Vec::new();
    input
        .take(FILE_MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Refusal::Unreadable)?;
    if bytes.len() as u64 > FILE_MAX {
        return Err(Refusal::Oversize);
    }
    String::from_utf8(bytes).map_err(|_| Refusal::Unreadable)
}

/// Used by direct user-preset lookup as well as list discovery; no bypassing
/// the safe reader by naming a preset explicitly.
#[nolog]
pub(super) fn read(path: &Path) -> Option<String> {
    let directory = open_directory(path.parent()?).ok()?;
    bounded_text(open_file(&directory, path.file_name()?).ok()?).ok()
}

#[nolog]
fn status(refusal: Refusal) -> (&'static str, &'static str) {
    match refusal {
        Refusal::Missing => ("missing", "The folder does not exist"),
        Refusal::NotDirectory | Refusal::NotFile => ("not_directory", "Not a folder"),
        Refusal::Link => (
            "link_refused",
            "Links, reparse points and cloud placeholders are not read",
        ),
        Refusal::Invalid => (
            "invalid_path",
            "Choose an absolute folder path without parent traversal",
        ),
        _ => ("unreadable", "The folder could not be read"),
    }
}

/// At most 500 directly contained Markdown candidates, rejected ones included.
/// Listing-only calls never read file contents. Content calls report later
/// open/read failures in the same state instead of silently losing templates.
#[nolog]
pub(super) fn scan(path: &Path, content: bool) -> (Value, Vec<Record>) {
    let mut state = json!({ "path": path.to_string_lossy(), "status": "ok", "count": 0 });
    let directory = match open_directory(path) {
        Ok(directory) => directory,
        Err(e) => {
            let (s, reason) = status(e);
            state["status"] = json!(s);
            state["error"] = json!(reason);
            return (state, vec![]);
        }
    };
    // The handles remain alive through enumeration and every file read.
    let entries = match fs::read_dir(listing_path(&directory)) {
        Ok(entries) => entries,
        Err(e) => {
            let (s, reason) = status(io_refusal(e));
            state["status"] = json!(s);
            state["error"] = json!(reason);
            return (state, vec![]);
        }
    };
    let mut files = Vec::new();
    let mut examined = 0;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                state["error"] = json!("Some directory entries could not be read");
                continue;
            }
        };
        let name = entry.file_name();
        if !Path::new(&name)
            .extension()
            .is_some_and(|x| x.to_string_lossy().eq_ignore_ascii_case("md"))
        {
            continue;
        }
        if examined == DIR_MAX {
            state["listing_truncated"] = json!(true);
            break;
        }
        examined += 1;
        let read = (|| {
            metadata(&directory, &name)?;
            if !content {
                return Ok(None);
            }
            let text = bounded_text(open_file(&directory, &name)?)?;
            Ok(Some(Text {
                chars: text.chars().count(),
                shown: text.chars().take(super::PRESET_MAX).collect(),
            }))
        })();
        match read {
            Ok(text) => files.push(Record {
                file: name.to_string_lossy().into_owned(),
                path: directory.path.join(&name),
                text,
            }),
            Err(refusal) => {
                let field = match refusal {
                    Refusal::Link => "skipped_links",
                    Refusal::NotFile | Refusal::NotDirectory => "not_files",
                    Refusal::Oversize => "oversize",
                    _ => "unreadable_files",
                };
                if state[field].is_null() {
                    state[field] = json!([]);
                }
                state[field]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(name.to_string_lossy()));
            }
        }
    }
    files.sort_by(|a, b| a.file.cmp(&b.file));
    state["count"] = json!(files.len());
    (state, files)
}

#[cfg(test)]
mod tests;
