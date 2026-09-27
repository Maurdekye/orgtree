"""Raw PostgreSQL custody storage. Callers own the enclosing transaction.

No routine call scans other owners. Conversion/export are explicit whole-section
operations; neither is a hidden repair during an append or a custody read.
"""
from __future__ import annotations

from typing import Any
from collections import Counter
from . import receiptrows


def _table(raw: Any, name: str) -> Any:
    from psycopg import sql
    # Use the caller's selected org schema; never interpolate a caller identifier.
    if name not in {"receipt_format", "receipt_owners", "receipts", "receipt_carriers", "doc"}:
        raise ValueError("unknown receipt relation")
    return sql.Identifier(name)


def _transaction(raw: Any) -> None:
    from psycopg.pq import TransactionStatus
    if raw.info.transaction_status != TransactionStatus.INTRANS:
        raise RuntimeError("receipt storage requires the caller's open transaction")


def convert(raw: Any, org_id: int) -> dict[str, Any] | None:
    """Convert a legacy blob once; unknown shapes keep their exact source.

    The caller must hold the normal whole-org/bootstrap exclusion. This helper
    also serializes converters and locks the source document against old writers.
    It never commits. A failure rolls back with its caller, including the marker.
    """
    _transaction(raw)
    if raw.execute("SELECT current_schema()").fetchone()[0] != f"org_{org_id}":
        raise RuntimeError("receipt conversion organization/schema mismatch")
    raw.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                (f"orgtree:receipt-conversion:{org_id}",))
    ready = raw.execute("SELECT format FROM receipt_format WHERE singleton").fetchone()
    if ready is not None:
        if ready[0] != 1:
            raise receiptrows.Unsupported("unknown receipt storage format")
        return {"format": receiptrows.FORMAT, "already_converted": True}
    row = raw.execute("SELECT val FROM doc WHERE key='mail_transitions' FOR UPDATE").fetchone()
    source = row[0] if row is not None else None
    try:
        converted = receiptrows.split(source)
    except receiptrows.Unsupported:
        return None
    for relation in ("receipt_owners", "receipts", "receipt_carriers"):
        from psycopg import sql
        if raw.execute(sql.SQL("SELECT 1 FROM {} LIMIT 1").format(_table(raw, relation))).fetchone():
            raise receiptrows.Unsupported("unmarked custody rows already exist")
    counts = Counter(record[0] for record in converted.receipts)
    for owner, ordinal in converted.owners:
        raw.execute("INSERT INTO receipt_owners(owner,ord,nrows,next_ord) VALUES(%s,%s,%s,%s)",
                    (owner, ordinal, counts[owner], counts[owner]))
    raw.execute("SELECT setval('receipt_owners_ord_seq',%s,%s)",
                (max(0,len(converted.owners)-1), bool(converted.owners)))
    # COPY is deliberately within the same transaction as verification/marker.
    with raw.cursor() as cursor:
        with cursor.copy("COPY receipts(owner,token,ord,val) FROM STDIN") as writer:
            for record in converted.receipts:
                writer.write_row(record)
        with cursor.copy("COPY receipt_carriers(owner,carrier,token) FROM STDIN") as writer:
            for record in converted.carriers:
                writer.write_row(record)
    stored = receiptrows.Converted(converted.present,
        tuple(raw.execute("SELECT owner,ord FROM receipt_owners ORDER BY ord").fetchall()),
        tuple(raw.execute("SELECT owner,token,ord,val FROM receipts ORDER BY owner,ord").fetchall()),
        tuple(raw.execute("SELECT owner,carrier,token FROM receipt_carriers ORDER BY owner,carrier,token").fetchall()),
        converted.checksum)
    proof = receiptrows.verify(stored)
    if proof != receiptrows.verify(converted):
        raise receiptrows.Unsupported("receipt conversion count/checksum mismatch")
    raw.execute("INSERT INTO receipt_format(singleton,format,present,conversion_sha256,"
                "converted_owners,converted_receipts,converted_carriers) VALUES(true,1,%s,%s,%s,%s,%s)",
                (converted.present, proof["sha256"], proof["owners"], proof["receipts"], proof["carriers"]))
    raw.execute("DELETE FROM doc WHERE key='mail_transitions'")
    return proof


def read_operations(raw: Any, owner: str, operations: list[str]) -> dict[str, Any] | None:
    """Exact keys, including a true empty result only after format validation."""
    _transaction(raw)
    ready = raw.execute("SELECT format FROM receipt_format WHERE singleton").fetchone()
    if ready is None:
        return None
    if ready[0] != 1:
        raise receiptrows.Unsupported("unknown receipt storage format")
    result = {}
    for token, value in raw.execute("SELECT token,val FROM receipts WHERE owner=%s AND token=ANY(%s)",
                                    (owner, operations)).fetchall():
        result[token] = receiptrows.validate_receipt(owner, token, receiptrows.loads(value))
    return result


def put(raw: Any, org_id: int, owner: str, operation: str, receipt: Any,
        *, expected: str | None = None) -> int:
    """Targeted append/CAS; stale evidence is an error, never silently replaced."""
    _transaction(raw)
    receiptrows.validate_receipt(owner, operation, receipt)
    value = receiptrows.dumps(receipt)
    row = raw.execute("SELECT public.orgtree_put_receipt(%s,%s,%s,%s,%s)",
                      (org_id, owner, operation, value, expected)).fetchone()
    if row is None:
        raise RuntimeError("receipt append returned no version")
    return int(row[0])


def delete(raw: Any, org_id: int, owner: str, operation: str, *, expected: str) -> bool:
    """Apply an existing compaction decision without deleting a newer receipt."""
    _transaction(raw)
    row = raw.execute("SELECT public.orgtree_delete_receipt(%s,%s,%s,%s)",
                      (org_id, owner, operation, expected)).fetchone()
    if row is None:
        raise RuntimeError("receipt deletion returned no result")
    return bool(row[0])


def replace_owners(raw: Any, org_id: int,
                   changes: dict[str, tuple[int | None, dict[str, Any] | None]]) -> None:
    """Explicit purge/rekey/replacement, guarded by each complete owner version.

    None as the replacement deletes an owner; an empty dict retains it. Rename
    is one call containing the old deletion and new owner with rewritten node
    fields, just as the ledger's existing dictionary operation. This is never
    used for routine append or individual compaction deletes.
    """
    _transaction(raw)
    if raw.execute("SELECT current_schema()").fetchone()[0] != f"org_{org_id}":
        raise RuntimeError("receipt replacement organization/schema mismatch")
    ready = raw.execute("SELECT format FROM receipt_format WHERE singleton").fetchone()
    if ready != (1,):
        raise receiptrows.Unsupported("receipt conversion incomplete")
    prepared = {}
    for owner, (version, value) in changes.items():
        # Validate everything before touching any owner. The codec also checks
        # empty owner identifiers and all extension data for finite JSON.
        converted = receiptrows.split(receiptrows.dumps({owner: value if value is not None else {}}))
        prepared[owner] = (version, value, converted)
    # Acquire ALL advisory locks before ALL summary locks, in canonical order.
    for owner in sorted(prepared):
        raw.execute("SELECT pg_advisory_xact_lock(hashtext(%s),hashtext(%s))",
                    (f"org_{org_id}", "receipt-owner:" + owner))
    for owner in sorted(prepared):
        row = raw.execute("SELECT version FROM receipt_owners WHERE owner=%s FOR UPDATE", (owner,)).fetchone()
        if (row[0] if row else None) != prepared[owner][0]:
            raise receiptrows.Unsupported("stale receipt owner replacement")
    # Preserve caller dictionary order for newly assigned owners.
    for owner, (version, value, converted) in prepared.items():
        raw.execute("DELETE FROM receipt_carriers WHERE owner=%s", (owner,))
        raw.execute("DELETE FROM receipts WHERE owner=%s", (owner,))
        if value is None:
            raw.execute("DELETE FROM receipt_owners WHERE owner=%s", (owner,))
            continue
        count = len(converted.receipts)
        if version is None:
            raw.execute("INSERT INTO receipt_owners(owner,nrows,next_ord) VALUES(%s,%s,%s)", (owner,count,count))
        else:
            raw.execute("UPDATE receipt_owners SET nrows=%s,next_ord=%s,version=nextval('receipt_owner_versions') WHERE owner=%s", (count,count,owner))
        with raw.cursor() as cursor:
            with cursor.copy("COPY receipts(owner,token,ord,val) FROM STDIN") as writer:
                for record in converted.receipts: writer.write_row(record)
            with cursor.copy("COPY receipt_carriers(owner,carrier,token) FROM STDIN") as writer:
                for record in converted.carriers: writer.write_row(record)
        raw.execute("UPDATE receipt_format SET present=true WHERE singleton AND NOT present")


def export(raw: Any) -> tuple[bool, dict[str, Any]] | None:
    """Explicit full-history reconstruction in the caller's coherent snapshot.

    No marker means legacy; a false presence bit is different from an empty
    mapping. Ordinal gaps caused by existing compaction/purge are legitimate.
    The stored conversion checksum describes the original import only, not
    subsequent authorized writes; current counts and carrier rows are checked.
    """
    _transaction(raw)
    marker = raw.execute("SELECT format,present FROM receipt_format WHERE singleton").fetchone()
    if marker is None:
        return None
    if marker[0] != 1:
        raise receiptrows.Unsupported("unknown receipt storage format")
    owners = raw.execute("SELECT owner,ord,nrows FROM receipt_owners ORDER BY ord").fetchall()
    receipts = raw.execute("SELECT owner,token,ord,val FROM receipts ORDER BY owner,ord").fetchall()
    carriers = raw.execute("SELECT owner,carrier,token FROM receipt_carriers ORDER BY owner,carrier,token").fetchall()
    counts = Counter(record[0] for record in receipts)
    if any(counts[owner] != count for owner, _, count in owners):
        raise receiptrows.Unsupported("receipt owner count mismatch")
    converted = receiptrows.Converted(marker[1], tuple((owner,ordinal) for owner,ordinal,_ in owners),
                                      tuple(receipts), tuple(carriers), "")
    value = receiptrows.assemble(converted)
    return marker[1], value
