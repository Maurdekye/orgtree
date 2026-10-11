//! Live sibling placement, shared by hire and reorder. Indices are zero based.
use anyhow::Result;
use serde_json::Value;
use tokio_postgres::Transaction;

use crate::refuse;

#[derive(Debug)]
pub(super) struct Sibling {
    pub id: i64,
    pub name: String,
    pub order: f64,
}

#[logged]
pub(super) fn index(req: &Value, required: bool) -> Result<Option<usize>> {
    match req.get("index") {
        None if required => refuse!(BadRequest, "agent hires and reorders require an explicit index (zero-based live sibling position)"),
        None => Ok(None),
        Some(v) => match v.as_u64().and_then(|n| usize::try_from(n).ok()) {
            Some(n) => Ok(Some(n)),
            None => refuse!(BadRequest, "index must be a nonnegative integer (zero-based live sibling position)"),
        },
    }
}

/// Pages only the live sibling set; row locks protect midpoint/rebalance writes.
/// The operation's serializable transaction also detects concurrent insertions
/// and parent changes, including an empty or top-level sibling set.
#[logged]
pub(super) async fn siblings(tx: &Transaction<'_>, org: i64, parent: Option<i64>, exclude: Option<i64>) -> Result<Vec<Sibling>> {
    let mut out = Vec::new();
    let mut after: Option<(f64, i64)> = None;
    loop {
        let order = after.map(|x| x.0);
        let id = after.map(|x| x.1);
        let page = tx.query(
            "SELECT id, name, sibling_order FROM ot.agents
             WHERE org_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND state='live'
               AND ($3::bigint IS NULL OR id<>$3)
               AND ($4::float8 IS NULL OR (sibling_order,id)>($4,$5::bigint))
             ORDER BY sibling_order,id LIMIT 256 FOR UPDATE",
            &[&org, &parent, &exclude, &order, &id]).await?;
        if page.is_empty() { break; }
        for r in page {
            let s = Sibling { id: r.get(0), name: r.get(1), order: r.get(2) };
            after = Some((s.order, s.id));
            out.push(s);
        }
    }
    Ok(out)
}

#[logged]
pub(super) fn position(req: &Value, list: &[Sibling], required: bool) -> Result<usize> {
    let index = index(req, required)?;
    let before = req.get("before");
    let after = req.get("after");
    if usize::from(index.is_some()) + usize::from(before.is_some()) + usize::from(after.is_some()) > 1 {
        refuse!(BadRequest, "choose exactly one placement: index, before or after");
    }
    let pos = if let Some(i) = index { i } else if let Some((v, offset)) = before.map(|v| (v, 0)).or_else(|| after.map(|v| (v, 1))) {
        let Some(name) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
            refuse!(BadRequest, "before/after must name a live sibling");
        };
        let Some(i) = list.iter().position(|s| s.name == name) else {
            refuse!(NotFound, "{name} is not a live sibling in this placement");
        };
        i + offset
    } else { list.len() };
    if pos > list.len() {
        refuse!(BadRequest, "index {pos} is out of range: expected 0..={} among live siblings", list.len());
    }
    Ok(pos)
}

#[nolog]
fn midpoint(list: &[Sibling], pos: usize) -> Option<f64> {
    let prev = if pos > 0 { list[pos - 1].order } else { list.first().map(|s| s.order - 2.0).unwrap_or(0.0) };
    let next = if pos < list.len() { list[pos].order } else { prev + 2.0 };
    let order = prev / 2.0 + next / 2.0;
    (prev.is_finite() && next.is_finite() && order.is_finite() && prev < order && order < next).then_some(order)
}

/// Preserve midpoint order normally. Equal orders or exhausted floating-point
/// gaps require a same-transaction normalization, preserving sibling order.
#[logged]
pub(super) async fn place(tx: &Transaction<'_>, list: &mut [Sibling], pos: usize) -> Result<(f64, Vec<i64>)> {
    if let Some(order) = midpoint(list, pos) { return Ok((order, Vec::new())); }
    let mut changed = Vec::new();
    for (i, s) in list.iter_mut().enumerate() {
        s.order = (i + 1) as f64 * 2.0;
        tx.execute("UPDATE ot.agents SET sibling_order=$2, row_version=row_version+1 WHERE id=$1", &[&s.id, &s.order]).await?;
        changed.push(s.id);
    }
    Ok((midpoint(list, pos).expect("normalized finite sibling gap"), changed))
}
