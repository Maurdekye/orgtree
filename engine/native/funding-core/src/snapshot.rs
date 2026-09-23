//! The funding-relevant facts of an organization, as synthetic input.
//!
//! Only what the funding step reads is modelled: each node's parent, state,
//! tier, grant, sort keys and bearer state, the tier price table and three
//! settings. Node order is the document's insertion order, which Python's
//! `children()` scan follows before sorting. Every node's `successor` is
//! taken to be `null` (see the README's parity domain).

use crate::pynum::{Outside, PyNum, R};
use orgtree_backend_codec::json::{Number, Value};
use orgtree_backend_codec::presence::Presence;

/// A document setting as stored: Python reads it with `.get(key, default)`
/// and applies `bool(...)` or `int(... or 0)`.
#[derive(Clone, Debug)]
pub enum Setting {
    Null,
    Bool(bool),
    Num(PyNum),
    Str(String),
}

impl Setting {
    /// Python `bool(value)`.
    pub fn truthy(&self) -> bool {
        match self {
            Setting::Null => false,
            Setting::Bool(b) => *b,
            Setting::Num(n) => n.truthy(),
            Setting::Str(s) => !s.is_empty(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Node {
    pub id: String,
    pub parent: Option<String>,
    pub state: String,
    pub model: String,
    pub grant: PyNum,
    /// `None` when the key is absent; `children()` then sorts it as `0`.
    pub ui_order: Option<PyNum>,
    pub created: String,
    /// `None` (Python `None`) or a string; only its truthiness and the value
    /// `"lost"` are used.
    pub bearer_state: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub nodes: Vec<Node>,
    pub tiers: Vec<(String, PyNum)>,
    pub settings: Vec<(String, Setting)>,
}

impl Snapshot {
    pub fn setting(&self, key: &str) -> Option<&Setting> {
        self.settings.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

const MALFORMED: Outside = Outside("malformed snapshot");

/// A JSON number as the Python value `json.loads` makes of it.
pub fn num_of(v: &Value) -> R<PyNum> {
    match v {
        Value::Number(n) => match n {
            Number::Finite(s) if n.is_integer_lexeme() => s
                .parse::<i128>()
                .map(PyNum::Int)
                .map_err(|_| Outside("int wider than i128")),
            Number::Finite(_) => Ok(PyNum::Float(n.to_f64())),
            Number::Infinity | Number::NegInfinity => Err(Outside("non-finite amount")),
            Number::NaN => Err(Outside("NaN amount")),
        },
        _ => Err(MALFORMED),
    }
}

pub fn str_of(v: &Value) -> R<String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        _ => Err(MALFORMED),
    }
}

fn setting_of(v: &Value) -> R<Setting> {
    Ok(match v {
        Value::Null => Setting::Null,
        Value::Bool(b) => Setting::Bool(*b),
        Value::Number(_) => Setting::Num(num_of(v)?),
        Value::String(s) => Setting::Str(s.clone()),
        _ => return Err(Outside("container-valued setting")),
    })
}

fn pairs(v: &Value) -> R<Vec<(String, &Value)>> {
    let Value::Array(items) = v else {
        return Err(MALFORMED);
    };
    items
        .iter()
        .map(|p| match p {
            Value::Array(kv) if kv.len() == 2 => Ok((str_of(&kv[0])?, &kv[1])),
            _ => Err(MALFORMED),
        })
        .collect()
}

/// Read a snapshot from the vectors' `spec` object:
/// `{"nodes": [[id, fields]...], "tiers": [[name, price]...],
/// "settings": [[key, value]...]}`.
pub fn parse_spec(v: &Value) -> R<Snapshot> {
    let Value::Object(o) = v else {
        return Err(MALFORMED);
    };
    let get = |k: &str| match o.get(k) {
        Presence::Present(x) => Ok(x),
        _ => Err(MALFORMED),
    };
    let mut snap = Snapshot::default();
    for (id, n) in pairs(get("nodes")?)? {
        if snap.nodes.iter().any(|x| x.id == id) {
            return Err(Outside("duplicate node id"));
        }
        let Value::Object(f) = n else {
            return Err(MALFORMED);
        };
        let parent = match f.get("parent") {
            Presence::Null => None,
            Presence::Present(p) => Some(str_of(p)?),
            Presence::Absent => return Err(MALFORMED),
        };
        let req = |k: &str| match f.get(k) {
            Presence::Present(x) => Ok(x),
            _ => Err(MALFORMED),
        };
        let ui_order = match f.get("ui_order") {
            Presence::Absent => None,
            Presence::Present(u @ Value::Number(_)) => Some(num_of(u)?),
            _ => return Err(Outside("non-numeric ui_order")),
        };
        let bearer_state = match f.get("bearer_state") {
            Presence::Absent | Presence::Null => None,
            Presence::Present(b) => {
                Some(str_of(b).map_err(|_| Outside("non-string bearer_state"))?)
            }
        };
        snap.nodes.push(Node {
            id,
            parent,
            state: str_of(req("state")?)?,
            model: str_of(req("model")?)?,
            grant: num_of(req("grant")?)?,
            ui_order,
            created: str_of(req("created")?)?,
            bearer_state,
        });
    }
    for (k, p) in pairs(get("tiers")?)? {
        if snap.tiers.iter().any(|(t, _)| *t == k) {
            return Err(Outside("duplicate tier"));
        }
        snap.tiers.push((k, num_of(p)?));
    }
    for (k, s) in pairs(get("settings")?)? {
        snap.settings.retain(|(x, _)| *x != k);
        snap.settings.push((k, setting_of(s)?));
    }
    Ok(snap)
}
