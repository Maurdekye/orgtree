//! Properties that hold independently of the Python vectors: the number
//! primitives against independent references, the planner's purity and
//! determinism, and the refusal classification and read-set grouping over
//! every committed scenario.

use orgtree_backend_codec::json::{parse, Limits, Profile, Value};
use orgtree_backend_codec::presence::Presence;
use orgtree_funding_core::ledger::Fail;
use orgtree_funding_core::pynum::{py_sum, q, PyNum, SumModel};
use orgtree_funding_core::snapshot::{parse_spec, Snapshot};
use orgtree_funding_core::vectors::COMMITTED;
use orgtree_funding_core::{Outcome, RefusalKind, Rules};

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
fn q_is_round_half_even_on_the_exact_value() {
    // Rust's `{:.2}` formats the exact binary value rounded half-to-even,
    // an implementation independent of the one under test.
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut checked = 0;
    for _ in 0..400_000 {
        let bits = rng.next();
        let exp = 1023 - 30 + rng.next() % 90;
        let x = f64::from_bits((bits & 0x800f_ffff_ffff_ffff) | (exp << 52));
        let want: f64 = format!("{x:.2}").parse().unwrap();
        let got = q(PyNum::Float(x)).unwrap();
        assert!(
            got.identical(PyNum::Float(want)),
            "q({x:?}) = {got:?}, want {want:?}"
        );
        checked += 1;
    }
    for x in [
        0.125,
        0.375,
        2.675,
        1.005,
        -0.005,
        -0.001,
        1e15 + 0.125,
        4503599627370495.5,
        1e300,
    ] {
        let want: f64 = format!("{x:.2}").parse().unwrap();
        assert!(
            q(PyNum::Float(x)).unwrap().identical(PyNum::Float(want)),
            "q({x:?})"
        );
    }
    assert!(q(PyNum::Float(-0.001))
        .unwrap()
        .identical(PyNum::Float(-0.0)));
    assert!(q(PyNum::Int(7)).unwrap().identical(PyNum::Int(7)));
    assert!(checked > 0);
}

#[test]
fn sum_of_ints_is_exact_and_stays_int() {
    let mut rng = Rng(7);
    for _ in 0..20_000 {
        let n = (rng.next() % 9) as usize;
        let xs: Vec<i128> = (0..n)
            .map(|_| i128::from(rng.next() as i64 >> (rng.next() % 64)))
            .collect();
        let items: Vec<PyNum> = xs.iter().map(|&x| PyNum::Int(x)).collect();
        let want: i128 = xs.iter().sum();
        let got = py_sum(&items, SumModel::CPYTHON_313_WIN64).unwrap();
        assert!(got.identical(PyNum::Int(want)), "{xs:?}");
    }
    assert!(py_sum(&[], SumModel::CPYTHON_313_WIN64)
        .unwrap()
        .identical(PyNum::Int(0)));
}

#[test]
fn sum_model_matches_measured_boundaries() {
    let m = SumModel::CPYTHON_313_WIN64;
    let s = |xs: &[PyNum]| py_sum(xs, m).unwrap();
    let f = PyNum::Float;
    // values measured on the engine runtime (CPython 3.13.15, Windows x64).
    // A 32-bit-long item: the compensated float phase keeps the 0.1 (the
    // int-to-float step itself is not compensated, hence ...648)
    assert!(s(&[PyNum::Int((1 << 31) - 1), f(1e16), f(0.1), f(-1e16)]).identical(f(2147483648.1)));
    // one past it: plain `+` loses the 0.1 to 1e16's spacing
    assert!(s(&[PyNum::Int(1 << 31), f(1e16), f(0.1), f(-1e16)]).identical(f(2147483648.0)));
    assert!(s(&[f(0.1); 10]).identical(f(1.0)));
}

#[test]
fn mixed_comparison_is_exact() {
    let big = PyNum::Int((1 << 53) + 1);
    assert!(big.gt(PyNum::Float(9007199254740992.0)).unwrap());
    assert!(PyNum::Int(3).eq_py(PyNum::Float(3.0)));
    assert!(PyNum::Int(-1).lt(PyNum::Float(-0.5)).unwrap());
    assert!(PyNum::Float(0.5)
        .py_min(PyNum::Int(1))
        .unwrap()
        .identical(PyNum::Float(0.5)));
    // min keeps the first argument on a tie
    assert!(PyNum::Int(2)
        .py_min(PyNum::Float(2.0))
        .unwrap()
        .identical(PyNum::Int(2)));
}

fn member<'a>(o: &'a Value, k: &str) -> Option<&'a Value> {
    match o {
        Value::Object(obj) => match obj.get(k) {
            Presence::Present(v) => Some(v),
            Presence::Null => Some(&Value::Null),
            Presence::Absent => None,
        },
        _ => None,
    }
}

fn s<'a>(row: &'a Value, k: &str) -> &'a str {
    match member(row, k) {
        Some(Value::String(x)) => x,
        _ => panic!("no string {k}"),
    }
}

fn n(row: &Value, k: &str) -> PyNum {
    let snap_num = member(row, k).expect("number");
    orgtree_funding_core::snapshot::num_of(snap_num).expect("finite number")
}

fn rows(section: &str) -> Vec<Value> {
    let doc = parse(
        COMMITTED,
        Profile::PythonLegacy,
        Limits {
            max_bytes: 64 << 20,
            max_depth: 64,
        },
    )
    .unwrap();
    match member(&doc, section) {
        Some(Value::Array(r)) => r.clone(),
        _ => panic!("no section {section}"),
    }
}

fn snapshot_text(s: &Snapshot) -> String {
    format!("{s:?}")
}

fn kind_of<T>(o: &Outcome<T>) -> Option<RefusalKind> {
    match &o.result {
        Err(Fail::Refused(r)) => Some(r.kind),
        _ => None,
    }
}

/// Every committed scenario, through the public API: the input snapshot is
/// untouched, a second evaluation is identical, the grouped participants
/// agree with the raw keys, and each refusal's kind agrees with its text.
#[test]
fn planner_is_pure_deterministic_and_classifies_refusals() {
    let r = Rules::LEGACY;
    let mut refusals = 0;
    for row in rows("acquire").iter().chain(rows("reallocate").iter()) {
        let snap = parse_spec(member(row, "spec").unwrap()).unwrap();
        let before = snapshot_text(&snap);
        let actor = s(row, "actor");
        let (a, b, kind, message) = if member(row, "payer").is_some() {
            let cascade = matches!(member(row, "cascade"), Some(Value::Bool(true)));
            let run = || {
                orgtree_funding_core::chain_acquire(
                    &snap,
                    actor,
                    s(row, "payer"),
                    n(row, "need"),
                    cascade,
                    &r,
                )
            };
            let (a, b) = (run(), run());
            let k = kind_of(&a);
            let m = match &a.result {
                Err(Fail::Refused(x)) => x.message.clone(),
                _ => String::new(),
            };
            (
                format!("{:?}", (&a.result, &a.grants_changed, &a.reads, &a.writes)),
                format!("{:?}", (&b.result, &b.grants_changed, &b.reads, &b.writes)),
                k,
                (m, a.participants.clone(), a.reads.clone()),
            )
        } else {
            let run = || {
                orgtree_funding_core::reallocate(&snap, actor, s(row, "node"), n(row, "delta"), &r)
            };
            let (a, b) = (run(), run());
            let k = kind_of(&a);
            let m = match &a.result {
                Err(Fail::Refused(x)) => x.message.clone(),
                _ => String::new(),
            };
            (
                format!("{:?}", (&a.result, &a.grants_changed, &a.reads, &a.writes)),
                format!("{:?}", (&b.result, &b.grants_changed, &b.reads, &b.writes)),
                k,
                (m, a.participants.clone(), a.reads.clone()),
            )
        };
        assert_eq!(
            before,
            snapshot_text(&snap),
            "the planner changed its input"
        );
        assert_eq!(a, b, "two evaluations differ");
        let (msg, participants, reads) = message;
        if participants.whole_table_scan {
            for node in &snap.nodes {
                assert!(
                    participants.nodes_read.contains(&node.id),
                    "scan without {}",
                    node.id
                );
                assert!(reads.contains(&format!("f:{}:parent", node.id)));
            }
        }
        if let Some(k) = kind {
            refusals += 1;
            let want = if msg.starts_with("not enough free credits on the chain") {
                RefusalKind::ChainShort
            } else if msg.contains("cost-bubbling is disabled") {
                RefusalKind::CascadeDisabledShort
            } else if msg.contains(" is not on ") {
                RefusalKind::NotOnChain
            } else if msg.contains("top-level grant cap") {
                RefusalKind::TopGrantCap
            } else if msg.contains(" has no authority over ") {
                RefusalKind::NoAuthority
            } else if msg.ends_with(", not live") {
                RefusalKind::NotLive
            } else if msg.starts_with("no such node") {
                RefusalKind::NoSuchNode
            } else if msg.starts_with("unknown actor") {
                RefusalKind::UnknownActor
            } else if msg.ends_with("the rest is committed") {
                RefusalKind::ReductionExceedsFree
            } else {
                panic!("unclassified refusal text {msg:?}")
            };
            assert_eq!(k, want, "{msg}");
        }
    }
    assert!(refusals > 400, "only {refusals} refusals seen");
}

/// The Python atomicity gap is reported, not repaired: a rehire refused
/// after it rehired archived superiors leaves them live, and any grants their
/// acquisitions inflated, in the result.
#[test]
fn partial_rehire_is_reported() {
    let (mut seen, mut inflated) = (0, 0);
    for row in rows("rehire") {
        let Some(Value::Array(states)) = member(&row, "states_changed") else {
            continue;
        };
        if member(&row, "raises").is_none() || states.is_empty() {
            continue;
        }
        let snap = parse_spec(member(&row, "spec").unwrap()).unwrap();
        let grant = match member(&row, "grant") {
            None | Some(Value::Null) => None,
            Some(_) => Some(n(&row, "grant")),
        };
        let out = orgtree_funding_core::rehire(
            &snap,
            s(&row, "actor"),
            s(&row, "node"),
            grant,
            &Rules::LEGACY,
        );
        assert!(
            matches!(
                kind_of(&out),
                Some(RefusalKind::ChainShort | RefusalKind::TopGrantCap)
            ),
            "{:?}",
            out.result
        );
        assert_eq!(out.states_changed.len(), states.len());
        if !out.grants_changed.is_empty() {
            inflated += 1;
        }
        seen += 1;
    }
    assert!(
        seen > 1,
        "only {seen} partial rehire scenarios in the vectors"
    );
    assert!(
        inflated > 0,
        "no partial rehire that kept an inflated grant"
    );
}
