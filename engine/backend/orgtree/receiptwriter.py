"""Prepare and apply selective receipt writes inside the caller's transaction.

Preparation captures immutable JSON and exact compare baselines. Applying never
commits or cleans the source mapping: rollback must leave every edit pending.
The store integration is responsible for adoption after its real commit.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from . import receiptmapping, receiptrows, receiptstore


@dataclass(frozen=True)
class Prepared:
    slug: str
    revision: int
    versions: tuple[tuple[str, int | None], ...]
    replacements: tuple[tuple[str, str | None, bool], ...]
    deletes: tuple[tuple[str, str, str], ...]
    writes: tuple[tuple[str, str, str, str | None, bool], ...]

    @property
    def owners(self) -> frozenset[str]:
        return frozenset(owner for owner, _ in self.versions)


def prepare(section: receiptmapping.ReceiptSection) -> Prepared:
    """Walk exposed values only; full owner replacements are explicit."""
    replacements = [(owner, None, False) for owner in sorted(section.deleted)]
    deletes = []
    writes = []
    for owner, value in section._data.items():
        if owner in section.replaced:
            plain = value.plain() if isinstance(value, receiptmapping.ReceiptOwner) else value
            # Validate the whole replacement before entering the write path.
            receiptrows.split(receiptrows.dumps({owner: plain}))
            replacements.append((owner, receiptrows.dumps(plain), owner in section.reinserted))
            continue
        if not isinstance(value, receiptmapping.ReceiptOwner) or value.owner != owner:
            raise receiptrows.Unsupported('receipt owner mapping identity mismatch')
        for token in sorted(value.deleted):
            old = value.baselines[token]
            if old is None:
                raise receiptrows.Unsupported('receipt deletion has no baseline')
            deletes.append((owner, token, old))
        for token, new, old in value.changed():
            writes.append((owner, token, new, old, token in value.reinserted))
    owners = {row[0] for rows in (replacements, deletes, writes) for row in rows}
    return Prepared(section.slug, section.revision,
                    tuple((owner, section.versions[owner]) for owner in sorted(owners)),
                    tuple(replacements), tuple(deletes), tuple(writes))


def apply(raw: Any, org_id: int, plan: Prepared) -> frozenset[str]:
    """Apply only captured rows, under all owner locks in canonical order.

    The enclosing store transaction also writes node/mail rows and publishes its
    revision. Nothing here adopts baselines, including when the caller rolls back.
    """
    receiptstore._transaction(raw)
    if raw.execute('SELECT current_schema()').fetchone()[0] != f'org_{org_id}':
        raise RuntimeError('receipt write organization/schema mismatch')
    current = raw.execute('SELECT slug,revision FROM public.orgs WHERE org_id=%s',
                          (org_id,)).fetchone()
    if current != (plan.slug, plan.revision):
        raise receiptmapping.StaleReceipts('receipt write view changed')
    if not plan.owners:
        return frozenset()
    if raw.execute('SELECT format FROM receipt_format WHERE singleton').fetchone() != (1,):
        raise receiptrows.Unsupported('receipt conversion incomplete')
    # Lock every advisory key BEFORE any summary row, even for mixed point and
    # whole-owner writes. Reentrant helper locks below preserve that ordering.
    for owner, _ in plan.versions:
        raw.execute('SELECT pg_advisory_xact_lock(hashtext(%s),hashtext(%s))',
                    (f'org_{org_id}', 'receipt-owner:' + owner))
    for owner, version in plan.versions:
        row = raw.execute('SELECT version FROM receipt_owners WHERE owner=%s FOR UPDATE',
                          (owner,)).fetchone()
        if (row[0] if row else None) != version:
            raise receiptmapping.StaleReceipts('receipt owner changed before save')
    versions = dict(plan.versions)
    if plan.replacements:
        receiptstore.replace_owners(raw, org_id,
            {owner: (versions[owner], receiptrows.loads(value) if value is not None else None)
             for owner, value, _ in plan.replacements},
            move_to_end={owner for owner, _, move in plan.replacements if move})
    for owner, token, old in plan.deletes:
        receiptstore.delete(raw, org_id, owner, token, expected=old)
    for owner, token, new, old, reinserted in plan.writes:
        if reinserted:
            receiptstore.delete(raw, org_id, owner, token, expected=old)
            old = None
        receiptstore.put(raw, org_id, owner, token, receiptrows.loads(new), expected=old)
    return plan.owners
