//! Python numbers as the ledger holds them: an `int` or a `float`.
//!
//! The ledger never converts amounts to one type. A hire stores `int(grant)`,
//! tier prices are ints or floats, and `_q` (`round(x, 2)`) keeps an int an
//! int. The kind is visible (a stored grant of `5` and `5.0` serialize
//! differently), so it is carried exactly. Ints are held as `i128`; a Python
//! int outside that range is outside the parity domain and is reported as
//! such, never wrapped.

use orgtree_backend_codec::credits::py_round2;
use std::cmp::Ordering;

/// Python produces an answer here that this crate does not reproduce. The
/// reason names what is missing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outside(pub &'static str);

pub type R<T> = Result<T, Outside>;

#[derive(Clone, Copy, Debug)]
pub enum PyNum {
    Int(i128),
    Float(f64),
}

const TWO_127: f64 = 170_141_183_460_469_231_731_687_303_715_884_105_728.0;
const WIDE: Outside = Outside("int wider than i128");

impl PyNum {
    /// CPython's int-to-float conversion, correctly rounded to nearest-even
    /// like Rust's `as`.
    pub fn to_f64(self) -> f64 {
        match self {
            PyNum::Int(i) => i as f64,
            PyNum::Float(f) => f,
        }
    }

    pub fn is_float(self) -> bool {
        matches!(self, PyNum::Float(_))
    }

    /// The same Python value and type: same kind and, for floats, the same
    /// bits (so `-0.0` and `0.0` differ, as their `repr` does).
    pub fn identical(self, o: PyNum) -> bool {
        match (self, o) {
            (PyNum::Int(a), PyNum::Int(b)) => a == b,
            (PyNum::Float(a), PyNum::Float(b)) => a.to_bits() == b.to_bits(),
            _ => false,
        }
    }

    pub fn py_add(self, o: PyNum) -> R<PyNum> {
        match (self, o) {
            (PyNum::Int(a), PyNum::Int(b)) => a.checked_add(b).map(PyNum::Int).ok_or(WIDE),
            _ => Ok(PyNum::Float(self.to_f64() + o.to_f64())),
        }
    }

    pub fn py_sub(self, o: PyNum) -> R<PyNum> {
        match (self, o) {
            (PyNum::Int(a), PyNum::Int(b)) => a.checked_sub(b).map(PyNum::Int).ok_or(WIDE),
            _ => Ok(PyNum::Float(self.to_f64() - o.to_f64())),
        }
    }

    pub fn py_neg(self) -> R<PyNum> {
        match self {
            PyNum::Int(a) => a.checked_neg().map(PyNum::Int).ok_or(WIDE),
            PyNum::Float(f) => Ok(PyNum::Float(-f)),
        }
    }

    /// Python's exact mixed comparison. `None` only for NaN.
    pub fn cmp_py(self, o: PyNum) -> Option<Ordering> {
        match (self, o) {
            (PyNum::Int(a), PyNum::Int(b)) => Some(a.cmp(&b)),
            (PyNum::Float(a), PyNum::Float(b)) => a.partial_cmp(&b),
            (PyNum::Int(a), PyNum::Float(b)) => cmp_int_float(a, b),
            (PyNum::Float(a), PyNum::Int(b)) => cmp_int_float(b, a).map(Ordering::reverse),
        }
    }

    pub fn lt(self, o: PyNum) -> R<bool> {
        self.cmp_py(o)
            .map(|c| c == Ordering::Less)
            .ok_or(Outside("NaN comparison"))
    }

    pub fn le(self, o: PyNum) -> R<bool> {
        self.cmp_py(o)
            .map(|c| c != Ordering::Greater)
            .ok_or(Outside("NaN comparison"))
    }

    pub fn gt(self, o: PyNum) -> R<bool> {
        o.lt(self)
    }

    pub fn ge(self, o: PyNum) -> R<bool> {
        o.le(self)
    }

    /// Python `==` between numbers (`1 == 1.0` is true).
    pub fn eq_py(self, o: PyNum) -> bool {
        self.cmp_py(o) == Some(Ordering::Equal)
    }

    /// Python truthiness.
    pub fn truthy(self) -> bool {
        match self {
            PyNum::Int(i) => i != 0,
            PyNum::Float(f) => f != 0.0,
        }
    }

    /// `min(self, o)`: Python keeps the first argument unless the second is
    /// strictly smaller, so on a tie the kind of `self` survives.
    pub fn py_min(self, o: PyNum) -> R<PyNum> {
        Ok(if o.lt(self)? { o } else { self })
    }

    /// `math.ceil`: always an int.
    pub fn ceil(self) -> R<PyNum> {
        match self {
            PyNum::Int(_) => Ok(self),
            PyNum::Float(f) => {
                if !f.is_finite() {
                    return Err(Outside("math.ceil of a non-finite float"));
                }
                let c = f.ceil();
                if (-TWO_127..TWO_127).contains(&c) {
                    Ok(PyNum::Int(c as i128))
                } else {
                    Err(WIDE)
                }
            }
        }
    }

    /// `int(x)` on a number: truncation toward zero.
    pub fn trunc_int(self) -> R<i128> {
        match self {
            PyNum::Int(i) => Ok(i),
            PyNum::Float(f) => {
                if !f.is_finite() {
                    return Err(Outside("int() of a non-finite float"));
                }
                let t = f.trunc();
                if (-TWO_127..TWO_127).contains(&t) {
                    Ok(t as i128)
                } else {
                    Err(WIDE)
                }
            }
        }
    }
}

/// Exact comparison of an int with a float, as CPython does it.
fn cmp_int_float(i: i128, f: f64) -> Option<Ordering> {
    if f.is_nan() {
        return None;
    }
    if f >= TWO_127 {
        return Some(Ordering::Less);
    }
    if f < -TWO_127 {
        return Some(Ordering::Greater);
    }
    let t = f.trunc();
    match i.cmp(&(t as i128)) {
        Ordering::Equal => {
            let frac = f - t;
            Some(if frac > 0.0 {
                Ordering::Less
            } else if frac < 0.0 {
                Ordering::Greater
            } else {
                Ordering::Equal
            })
        }
        o => Some(o),
    }
}

/// How `_q` rounds a float. `HalfEven` is CPython; the others exist only as
/// negative controls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Round2 {
    /// CPython `round(x, 2)`: the exact binary value, ties to even.
    HalfEven,
    /// Control: `floor(x * 100 + 0.5) / 100` in floating point.
    NaiveHalfUp,
    /// Control: no quantisation at all.
    Identity,
}

/// The ledger's `_q`: `round(x, 2)`. An int comes back unchanged; a float
/// becomes the double nearest the rounded decimal, which is exactly what
/// CPython's dtoa-then-strtod produces. A negative result that rounds to
/// zero keeps its sign (`round(-0.001, 2)` is `-0.0`).
///
/// The backend codec's `py_round2` answers the credit range exactly; outside
/// it, a float of magnitude 2**52 or more is already a whole number and is
/// its own rounding, and anything in between is rounded here with the same
/// integer arithmetic.
pub fn q_with(x: PyNum, mode: Round2) -> R<PyNum> {
    let f = match x {
        PyNum::Int(_) => return Ok(x),
        PyNum::Float(f) => f,
    };
    if !f.is_finite() {
        // round(inf, 2) and round(nan, 2) return the value itself.
        return Ok(x);
    }
    match mode {
        Round2::Identity => return Ok(x),
        Round2::NaiveHalfUp => return Ok(PyNum::Float((f * 100.0 + 0.5).floor() / 100.0)),
        Round2::HalfEven => {}
    }
    if let Ok(r) = py_round2(f) {
        if r.negative_zero {
            return Ok(PyNum::Float(-0.0));
        }
        return Ok(PyNum::Float(nearest_hundredths(
            r.hundredths.unsigned_abs().into(),
            r.hundredths < 0,
        )));
    }
    if f.abs() >= 4_503_599_627_370_496.0 {
        return Ok(x);
    }
    // |f| < 2**52: the codec refused only for range, so round here exactly.
    let bits = f.to_bits();
    let negative = bits >> 63 == 1;
    let exp_bits = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if exp_bits == 0 {
        (frac, -1074)
    } else {
        (frac | (1u64 << 52), exp_bits - 1075)
    };
    let n = u128::from(m) * 100;
    let h = if e >= 0 {
        n << e
    } else {
        let k = e.unsigned_abs();
        let q = n >> k;
        let r = n & ((1u128 << k) - 1);
        let half = 1u128 << (k - 1);
        if r > half || (r == half && q & 1 == 1) {
            q + 1
        } else {
            q
        }
    };
    if negative && h == 0 {
        return Ok(PyNum::Float(-0.0));
    }
    Ok(PyNum::Float(nearest_hundredths(h, negative)))
}

/// The double nearest `h / 100`, via Rust's correctly rounded decimal
/// parser, so no intermediate float division can double-round.
fn nearest_hundredths(h: u128, negative: bool) -> f64 {
    let text = format!(
        "{}{}.{:02}",
        if negative { "-" } else { "" },
        h / 100,
        h % 100
    );
    text.parse::<f64>().unwrap_or(f64::NAN)
}

pub fn q(x: PyNum) -> R<PyNum> {
    q_with(x, Round2::HalfEven)
}

/// Which `sum()` this is. [`SumModel::CPYTHON_313_WIN64`] is the measured
/// behaviour of the engine runtime; the others are negative controls.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SumModel {
    /// Neumaier compensation in the float phase (CPython 3.12+).
    pub compensated: bool,
    /// Bits of the C `long` an int item must fit for either fast path. On
    /// 64-bit Windows `long` is 32 bits, so an int item outside
    /// [-2**31, 2**31) leaves the fast path.
    pub long_bits: u32,
}

impl SumModel {
    pub const CPYTHON_313_WIN64: SumModel = SumModel {
        compensated: true,
        long_bits: 32,
    };
}

/// CPython 3.13 `sum(items)` with the default start `0`, as measured on the
/// engine runtime (Windows x64, where C `long` is 32 bits).
///
/// 1. Int phase: an int item that fits a C `long` is added to an exact
///    64-bit accumulator while the accumulator does not overflow.
/// 2. The first other item (a float, a wider int, or an overflow) is added
///    to the accumulated int with ordinary `+`.
/// 3. If that gave a float, the float phase runs: floats are summed with
///    Neumaier compensation, ints that fit a C `long` are added as plain
///    doubles, and at the end the compensation is added when it is nonzero
///    and finite.
/// 4. Any other item there (a wider int) adds the compensation (same rule),
///    then continues with ordinary `+` for every remaining item, as does a
///    non-float result of step 2.
pub fn py_sum(items: &[PyNum], model: SumModel) -> R<PyNum> {
    let lim: i128 = 1i128 << (model.long_bits - 1);
    let fits = |x: i128| (-lim..lim).contains(&x);
    let mut acc: i64 = 0;
    let mut rest = items.iter();
    let mut result: Option<PyNum> = None;
    for &x in rest.by_ref() {
        if let PyNum::Int(b) = x {
            if fits(b) {
                if let Some(s) = acc.checked_add(b as i64) {
                    acc = s;
                    continue;
                }
            }
        }
        result = Some(PyNum::Int(i128::from(acc)).py_add(x)?);
        break;
    }
    let mut result = match result {
        None => return Ok(PyNum::Int(i128::from(acc))),
        Some(r) => r,
    };
    if let PyNum::Float(start) = result {
        let mut f = start;
        let mut c = 0.0f64;
        let mut fell = None;
        for &x in rest.by_ref() {
            match x {
                PyNum::Float(v) => {
                    if model.compensated {
                        let t = f + v;
                        if f.abs() >= v.abs() {
                            c += (f - t) + v;
                        } else {
                            c += (v - t) + f;
                        }
                        f = t;
                    } else {
                        f += v;
                    }
                }
                PyNum::Int(i) if fits(i) => f += i as f64,
                other => {
                    fell = Some(other);
                    break;
                }
            }
        }
        if c != 0.0 && c.is_finite() {
            f += c;
        }
        match fell {
            None => return Ok(PyNum::Float(f)),
            Some(x) => result = PyNum::Float(f).py_add(x)?,
        }
    }
    for &x in rest {
        result = result.py_add(x)?;
    }
    Ok(result)
}
