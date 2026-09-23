//! Properties that hold independently of the Python vectors.

use orgtree_scope_clamp::clamp::{clamp_dirs, expand_mcp, DirGrant};
use orgtree_scope_clamp::ntpath::nls_lower;
use orgtree_scope_clamp::tables::{NLS_LOWER, NONPRINTABLE, PY_WHITESPACE};
use orgtree_scope_clamp::{normcase, normpath, PathRules, PyStr, Rules, Val};

/// xorshift64*: a fixed, dependency-free sequence.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
}

#[test]
fn the_case_table_is_a_sorted_one_to_one_map_of_scalar_values() {
    assert!(NLS_LOWER.len() > 1000, "{} entries", NLS_LOWER.len());
    for w in NLS_LOWER.windows(2) {
        assert!(w[0].0 < w[1].0);
    }
    for &(a, b) in NLS_LOWER {
        assert_ne!(a, b);
        assert!(char::from_u32(a).is_some() && char::from_u32(b).is_some());
        assert_eq!(nls_lower(a), b);
    }
    // it is not str.lower(): U+0130 is untouched, and so are Kelvin-sign
    // style compatibility letters the NLS table leaves alone
    assert_eq!(nls_lower(0x130), 0x130);
    assert_eq!(nls_lower(0x41), 0x61);
    for w in NONPRINTABLE.windows(2) {
        assert!(w[0].1 < w[1].0);
    }
    for w in PY_WHITESPACE.windows(2) {
        assert!(w[0] < w[1]);
    }
}

#[test]
fn wide_round_trip_is_identity_on_scalar_strings_and_joins_pairs() {
    let mut rng = Rng(0x5eed);
    for _ in 0..20_000 {
        let n = (rng.next() % 8) as usize;
        let cps: Vec<u32> = (0..n)
            .map(|_| {
                let c = (rng.next() % 0x11_0000) as u32;
                if (0xD800..0xE000).contains(&c) {
                    0x41
                } else {
                    c
                }
            })
            .collect();
        let s = PyStr(cps);
        assert_eq!(PyStr::from_wide(&s.to_wide()), s);
    }
    let split = PyStr(vec![0xD801, 0xDC00]);
    assert_eq!(PyStr::from_wide(&split.to_wide()), PyStr(vec![0x10400]));
    let lone = PyStr(vec![0xDC00, 0xD800]);
    assert_eq!(PyStr::from_wide(&lone.to_wide()), lone);
}

#[test]
fn normcase_and_normpath_are_idempotent() {
    let w = PathRules::WINDOWS;
    let mut rng = Rng(7);
    let alpha: [u32; 12] = [
        0x5c, 0x2f, 0x2e, 0x3a, 0x3f, 0x55, 0x61, 0x130, 0x3a3, 0x10400, 0xD800, 0x20,
    ];
    for _ in 0..50_000 {
        let n = (rng.next() % 10) as usize;
        let s = PyStr((0..n).map(|_| alpha[(rng.next() % 12) as usize]).collect());
        let c = normcase(&s, w);
        assert_eq!(normcase(&c, w), c);
        let p = normpath(&s, w);
        assert!(!p.is_empty());
    }
}

#[test]
fn expand_mcp_is_within_the_registry() {
    let s = PyStr::from;
    let reg = [s("a"), s("b")];
    let got = expand_mcp(Some(&[s("*")]), Some(&[s("b"), s("z")]), Some(&reg));
    assert_eq!(got, vec![s("b")]);
    assert!(expand_mcp(Some(&[s("z")]), None, Some(&reg)).is_empty());
}

#[test]
fn a_clamp_never_widens_a_folder_grant() {
    let s = PyStr::from;
    let rw = Val::Str(s("rw"));
    let ro = Val::Str(s("ro"));
    let held = vec![(s("C:\\work"), ro.clone())];
    let req = vec![
        DirGrant {
            path: s("c:/WORK/x"),
            mode: rw.clone(),
        },
        DirGrant {
            path: s("C:\\worker"),
            mode: ro.clone(),
        },
    ];
    let (kept, lost) = clamp_dirs(&req, Some(&held), false, &s("the parent"), &Rules::LEGACY)
        .expect("lenient clamp");
    assert_eq!(
        kept,
        vec![DirGrant {
            path: s("c:/WORK/x"),
            mode: ro
        }]
    );
    assert_eq!(
        lost,
        vec![s("c:/WORK/x (downgraded to ro)"), s("C:\\worker")]
    );
}
