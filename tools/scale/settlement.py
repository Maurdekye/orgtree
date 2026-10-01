"""Mailbox drain respects the product's passive-notice contract."""


def settled(row):
    if not isinstance(row, dict):
        return False
    if "waking_mail" in row:
        if row.get("mail") != row["waking_mail"] + row.get("passive_mail", -1):
            return False
        waking = row["waking_mail"]
    else:
        waking = row.get("mail")  # old server: require a completely empty box
    return waking == 0 and all(row.get(k) == 0 for k in ("delivering", "inflight", "busy", "queued"))
