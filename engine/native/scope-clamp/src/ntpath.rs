//! `ntpath.normpath` and `ntpath.normcase` exactly as the engine runtime
//! (CPython 3.13 on Windows) computes them.
//!
//! * `normpath` is the C builtin `nt._path_normpath`: CPython's
//!   `_Py_normpath_and_size` with the Windows `_Py_skiproot`, run in place
//!   over the UTF-16 code units of the string (plus the terminating NUL the
//!   wide-string conversion allocates), and converted back with
//!   `PyUnicode_FromWideChar`, which joins surrogate pairs.
//! * `normcase` is `_winapi.LCMapStringEx(LOCALE_NAME_INVARIANT,
//!   LCMAP_LOWERCASE, s.replace('/', '\\'))`: the Windows NLS invariant
//!   lowercase table, applied per code point after the same UTF-16 round
//!   trip. It is NOT `str.lower()`. The table is the one the oracle captured
//!   from the host (`tables::NLS_LOWER`, stamped with the Windows build).

use crate::pystr::PyStr;
use crate::tables::NLS_LOWER;

const SEP: u16 = b'\\' as u16;
const ALTSEP: u16 = b'/' as u16;
const DOT: u16 = b'.' as u16;

/// Path semantics to apply. [`PathRules::WINDOWS`] is the engine runtime;
/// the others are deliberate mistakes used as negative controls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PathRules {
    /// POSIX `normpath`/`normcase` instead of Windows (only `/` separates,
    /// no drives, case kept).
    pub posix: bool,
    /// Lowercase ASCII only instead of the NLS table.
    pub ascii_lower_only: bool,
}

impl PathRules {
    pub const WINDOWS: PathRules = PathRules {
        posix: false,
        ascii_lower_only: false,
    };
}

fn is_sep(c: u16) -> bool {
    c == SEP || c == ALTSEP
}

/// `_Py_skiproot` (Windows): (drive size, root size) in code units.
fn skiproot(p: &[u16], size: usize) -> (usize, usize) {
    if size > 1 && is_sep(p[0]) {
        if is_sep(p[1]) {
            // UNC or device path: \\server\share, \\?\UNC\server\share,
            // \\.\device, \\?\device
            let lower = |c: u16| c | 0x20;
            let mut idx = if size > 7
                && p[2] == b'?' as u16
                && is_sep(p[3])
                && lower(p[4]) == b'u' as u16
                && lower(p[5]) == b'n' as u16
                && lower(p[6]) == b'c' as u16
                && is_sep(p[7])
            {
                8
            } else {
                2
            };
            while idx < size && !is_sep(p[idx]) {
                idx += 1;
            }
            if idx == size {
                return (size, 0);
            }
            idx += 1;
            while idx < size && !is_sep(p[idx]) {
                idx += 1;
            }
            if idx < size {
                return (idx, 1);
            }
            return (idx, 0);
        }
        return (0, 1);
    }
    if size > 1 && p[1] == b':' as u16 {
        if size > 2 && is_sep(p[2]) {
            return (2, 1);
        }
        return (2, 0);
    }
    (0, 0)
}

/// `_Py_normpath_and_size` over a NUL-terminated wide buffer, in place.
/// Returns (start, length) of the result within `buf`.
fn normpath_wide(buf: &mut [u16], size: usize) -> (usize, usize) {
    if size == 0 {
        return (0, 0);
    }
    let end = size;
    let is_end = |x: usize| x == end;
    let mut path = 0usize;
    let mut p1 = 0usize;
    let mut p2 = 0usize;
    let mut min_p2 = 0usize;
    let mut last_c: u16 = 0;
    let (drv, root) = skiproot(buf, size);
    if drv != 0 || root != 0 {
        p1 = drv + root;
        while p2 < p1 {
            if buf[p2] == ALTSEP {
                buf[p2] = SEP;
            }
            p2 += 1;
        }
        min_p2 = p2 - 1;
        last_c = buf[min_p2];
        if last_c != SEP {
            min_p2 += 1;
        }
    }
    let mut skipped = false;
    while !is_end(p1) && buf[p1] == DOT && (is_end(p1 + 1) || is_sep(buf[p1 + 1])) {
        // skip each leading "." or ".\" after any drive (and the
        // separators after it)
        p1 += 1;
        while !is_end(p1) && is_sep(buf[p1]) {
            p1 += 1;
        }
        skipped = true;
    }
    if skipped && drv == 0 && root == 0 {
        path = p1;
        p2 = p1;
        min_p2 = p1;
        last_c = SEP;
    }
    let sep_or_end = |b: &[u16], x: usize| x == end || is_sep(b[x]);
    while !is_end(p1) {
        let mut c = buf[p1];
        if c == ALTSEP {
            c = SEP;
        }
        if last_c == SEP {
            if c == DOT {
                let sep_at_1 = sep_or_end(buf, p1 + 1);
                let sep_at_2 = !sep_at_1 && sep_or_end(buf, p1 + 2);
                if sep_at_2 && buf[p1 + 1] == DOT {
                    let mut p3 = p2;
                    while p3 != min_p2 {
                        p3 -= 1;
                        if buf[p3] != SEP {
                            break;
                        }
                    }
                    while p3 != min_p2 && buf[p3 - 1] != SEP {
                        p3 -= 1;
                    }
                    if p2 == min_p2 || (buf[p3] == DOT && buf[p3 + 1] == DOT && is_sep(buf[p3 + 2]))
                    {
                        buf[p2] = DOT;
                        p2 += 1;
                        buf[p2] = DOT;
                        p2 += 1;
                        last_c = DOT;
                    } else if buf[p3] == SEP {
                        p2 = p3 + 1;
                    } else {
                        p2 = p3;
                    }
                    p1 += 1;
                } else if sep_at_1 {
                } else {
                    buf[p2] = c;
                    last_c = c;
                    p2 += 1;
                }
            } else if c == SEP {
            } else {
                buf[p2] = c;
                last_c = c;
                p2 += 1;
            }
        } else {
            buf[p2] = c;
            last_c = c;
            p2 += 1;
        }
        p1 += 1;
    }
    buf[p2] = 0;
    if p2 != min_p2 {
        loop {
            p2 -= 1;
            if p2 == min_p2 || buf[p2] != SEP {
                break;
            }
            buf[p2] = 0;
        }
    } else {
        // p2 - 1 may precede `path` (an empty result); the length is 0 then
        return (path, p2.saturating_sub(path));
    }
    (path, p2 + 1 - path)
}

/// `ntpath.normpath(s)`.
pub fn normpath(s: &PyStr, rules: PathRules) -> PyStr {
    if rules.posix {
        return posix_normpath(s);
    }
    let mut w = s.to_wide();
    let size = w.len();
    w.push(0);
    w.push(0);
    let (start, len) = normpath_wide(&mut w, size);
    if len == 0 {
        return PyStr::from(".");
    }
    PyStr::from_wide(&w[start..start + len])
}

/// `ntpath.normcase(s)`.
pub fn normcase(s: &PyStr, rules: PathRules) -> PyStr {
    if rules.posix {
        return s.clone();
    }
    let slashed = s.replace_cp(u32::from(ALTSEP), u32::from(SEP));
    // the wide round trip joins surrogate pairs before the table applies
    let joined = PyStr::from_wide(&slashed.to_wide());
    PyStr(
        joined
            .0
            .iter()
            .map(|&c| {
                if rules.ascii_lower_only {
                    if (0x41..=0x5a).contains(&c) {
                        c + 0x20
                    } else {
                        c
                    }
                } else {
                    nls_lower(c)
                }
            })
            .collect(),
    )
}

/// One code point through the captured NLS invariant lowercase table.
pub fn nls_lower(c: u32) -> u32 {
    match NLS_LOWER.binary_search_by_key(&c, |&(k, _)| k) {
        Ok(i) => NLS_LOWER[i].1,
        Err(_) => c,
    }
}

/// `posixpath.normpath`, used only by the POSIX control.
fn posix_normpath(s: &PyStr) -> PyStr {
    let slash = u32::from(b'/');
    if s.is_empty() {
        return PyStr::from(".");
    }
    let initial = s.0.iter().take_while(|&&c| c == slash).count();
    let lead = if initial == 2 {
        2
    } else {
        usize::from(initial > 0)
    };
    let mut out: Vec<Vec<u32>> = Vec::new();
    for comp in s.0.split(|&c| c == slash) {
        if comp.is_empty() || comp == [u32::from(DOT)] {
            continue;
        }
        let dd = comp == [u32::from(DOT), u32::from(DOT)];
        if !dd || (lead == 0 && out.is_empty()) || out.last().is_some_and(|l| l == &[46, 46]) {
            out.push(comp.to_vec());
        } else if !out.is_empty() {
            out.pop();
        }
    }
    let mut v: Vec<u32> = vec![slash; lead];
    for (i, c) in out.iter().enumerate() {
        if i > 0 {
            v.push(slash);
        }
        v.extend_from_slice(c);
    }
    if v.is_empty() {
        return PyStr::from(".");
    }
    PyStr(v)
}
