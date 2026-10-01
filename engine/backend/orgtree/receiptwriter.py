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
    # Set for a view loaded inside an org_tx: freshness comes from that
    # transaction's locks and owner versions, not from the org revision.
    bound: receiptmapping.TxBinding | None = None
    # Owner-version view: freshness is each written owner's version (checked
    # FOR UPDATE below), not the org revision.
    versioned: bool = False

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
            encoded = receiptrows.dumps(plain)
            if encoded != section.replacement_baselines.get(owner) or owner in section.reinserted:
                replacements.append((owner, encoded, owner in section.reinserted))
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
                    tuple(replacements), tuple(deletes), tuple(writes), section.bound,
                    section.versioned)


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
    if plan.bound is not None:
        # Concurrent disjoint org_tx commits legitimately advance the revision.
        # The plan must be applied in the transaction that loaded it; owner
        # versions below still refuse any concurrent change to these owners.
        if (plan.bound.conn(plan.slug).raw is not raw or current is None
                or current[0] != plan.slug):
            raise receiptmapping.StaleReceipts('receipt write outside its transaction')
    elif plan.versioned:
        if current is None or current[0] != plan.slug:
            raise receiptmapping.StaleReceipts('receipt write view changed')
    elif current != (plan.slug, plan.revision):
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


@dataclass(frozen=True)
class Adoption:
    plan: Prepared
    revision: int
    summaries: tuple[tuple[str, int, int], ...]

    def install(self, section: receiptmapping.ReceiptSection) -> None:
        """Update baselines in place; existing mutable references stay attached."""
        if prepare(section) != self.plan:
            raise receiptmapping.StaleReceipts('receipt mapping changed before adoption')
        summaries = {owner: (count, version) for owner, count, version in self.summaries}
        for owner, encoded, _ in self.plan.replacements:
            if encoded is None:
                section.versions[owner] = None
                section.missing.add(owner)
                section.replacement_baselines.pop(owner, None)
                continue
            value = section._data[owner]
            count, version = summaries[owner]
            section.versions[owner] = version
            if isinstance(value, receiptmapping.ReceiptOwner):
                # Explicit owner replacement/move materialized it during prepare.
                value.baselines = {key: receiptrows.dumps(row)
                                   for key, row in receiptrows.loads(encoded).items()}
                value.deleted.clear()
                value.reinserted.clear()
                value.count, value.version, value.complete = count, version, True
                section.replaced.discard(owner)
                section.replacement_baselines.pop(owner, None)
            else:
                # Leave a caller's plain dict exactly where it is. A future edit,
                # including direct pop/update through an old alias, is compared
                # as an explicit complete-owner replacement.
                section.replacement_baselines[owner] = encoded
        for owner, token, _ in self.plan.deletes:
            value = section._data[owner]
            value.baselines[token] = None
            value.deleted.discard(token)
        for owner, token, encoded, _, _ in self.plan.writes:
            value = section._data[owner]
            value.baselines[token] = encoded
            value.reinserted.discard(token)
        for owner, count, version in self.summaries:
            section.versions[owner] = version
            value = section._data[owner]
            if isinstance(value, receiptmapping.ReceiptOwner):
                value.count, value.version = count, version
        if section.snapshot is not None:
            for owner, encoded, _ in self.plan.replacements:
                if encoded is None:
                    section.snapshot.pop(owner, None)
            for owner, count, version in self.summaries:
                section.snapshot[owner] = (count, version)
                value = section._data.get(owner)
                if isinstance(value, receiptmapping.ReceiptOwner):
                    value.versioned = True
        section.deleted.clear()
        section.reinserted.clear()
        section.revision = self.revision
        for value in section._data.values():
            if isinstance(value, receiptmapping.ReceiptOwner):
                value.revision = self.revision


def adoption_after_revision(conn: Any, section: receiptmapping.ReceiptSection,
                            plan: Prepared) -> Adoption:
    """Capture adoption after on_save_commit, BEFORE the real COMMIT.

    For a snapshot view, a consecutive revision proves that no other org commit
    was missed between the original snapshot and our revision update. A
    transaction-bound view needs no such proof: its owners were read and written
    under this transaction's locks, and owner versions guarded the write. On a
    gap refuse while the enclosing transaction can still roll back; never retag
    stale cached owners.
    The caller queues install through receiptcommit, or calls it after its own
    successful standalone COMMIT. Merely constructing this value cleans nothing.
    """
    receiptstore._transaction(conn.raw)
    conn.use()
    if conn.slug != plan.slug or prepare(section) != plan:
        raise receiptmapping.StaleReceipts('receipt mapping changed before commit')
    if plan.bound is not None:
        # A transaction-bound view is not a revision-tagged cache: it keeps its
        # load revision and refuses lazy reads once the transaction ends.
        if plan.bound.conn(plan.slug) is not conn:
            raise receiptmapping.StaleReceipts('receipt adoption outside its transaction')
        expected = plan.revision
    elif plan.versioned:
        # Per-owner views: the written owners' new versions are read below in
        # this transaction; every other owner keeps its own checked version.
        expected = plan.revision
    else:
        row = conn.raw.execute('SELECT slug,revision FROM public.orgs WHERE org_id=%s',
                               (conn.org_id,)).fetchone()
        expected = plan.revision + (1 if conn.last_revision is not None else 0)
        if row != (plan.slug, expected) or (conn.last_revision is not None and conn.last_revision != expected):
            raise receiptmapping.StaleReceipts('receipt snapshot missed an intervening commit')
    if plan.owners and conn.last_revision is None:
        raise RuntimeError('receipt writes require revision publication before adoption')
    summaries = tuple(conn.raw.execute(
        'SELECT owner,nrows,version FROM receipt_owners WHERE owner=ANY(%s) ORDER BY owner',
        (sorted(plan.owners),)).fetchall()) if plan.owners else ()
    removed = {owner for owner, value, _ in plan.replacements if value is None}
    if {owner for owner, _, _ in summaries} != plan.owners - removed:
        raise receiptmapping.StaleReceipts('receipt owner missing from adoption snapshot')
    return Adoption(plan, expected, summaries)
