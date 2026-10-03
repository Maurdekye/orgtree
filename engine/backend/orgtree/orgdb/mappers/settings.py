"""The org's settings: one ``org_settings`` row (design Appendix A.1).

Every registered org-level key that no list or map section owns is a column here: scalars as
typed columns, objects as one JSON column each (their shape varies by build, Q1). Types follow
the real rehearsal inputs; a key none of them holds is typed from its writers where that is
plain, else JSON. A value of another type than its column's goes to ``extra`` exactly (codec),
so a wrong guess never loses anything.

The removed features' keys (``ledger.IGNORED_LEGACY_KEYS``: the kiosk, the spend freeze, the
per-org sandbox, its disk, storage limits and bridge credential) are not here: the converter
does not carry them (decision 17 and the sandbox removal). The exception is ``sandbox`` itself
(``mappers.KEPT_LEGACY``, design rev 7.2), kept as a JSON column for the former-sandbox
credential catch-up to read after the conversion.
"""

from __future__ import annotations

from .. import enum_values as V
from ..codec import Field as F, Spec

SETTINGS = Spec("org_settings", (
    F("version", "int"),
    F("slug", "text"),
    F("name", "text"),
    F("created", "ts"),
    F("workspace", "text"),
    F("permission_mode", "text", values=V.PERMISSION),
    F("default_visibility", "text", values=V.VISIBILITY),
    F("default_effort", "text", values=V.EFFORT),
    F("max_top_grant", "num"),
    F("default_top_grant", "num"),
    F("compact_at", "num"),
    F("max_children", "int"),
    F("max_depth", "int"),
    F("fable_limit_policy", "text", values=('halt', 'opus', 'dissolve')),
    F("fable_filter_policy", "text", values=('halt', 'opus', 'auto-autopsy')),
    F("fable_filter_model", "text"),
    F("fable_api_fallback", "json"),
    F("fable_lock", "json", nullable=True),
    F("cascade_hire", "bool"),
    F("cascade_alloc", "bool"),
    F("auto_resume", "bool"),
    F("auto_resume_compact", "bool"),
    F("auto_resume_last", "num"),
    F("auto_cheap_compact", "json", nullable=True),
    F("default_tools", "json", nullable=True),
    F("default_dirs", "json", nullable=True),
    F("default_account", "text", nullable=True),
    F("account_fallback_default", "json", nullable=True),
    F("account_token_uuid", "text", nullable=True),
    F("killswitch", "json", nullable=True),
    F("net_autoconnect", "bool"),
    F("net_identity", "json", nullable=True),
    F("net_spool", "json", nullable=True),
    F("external_inbox_multi_holder", "bool"),
    F("org_inbox_multi_holder", "bool"),
    F("org_inbox_read", "int"),
    F("mail_drain_version", "int"),
    F("reply_incarnation", "text"),
    F("work_identity", "text"),
    F("whole_grants_v1", "bool"),
    F("_actors_typed", "bool", col="actors_typed"),
    F("deleted_cost_usd", "num"),
    F("deleted_cost_usd_unknown", "bool"),
    F("api_cost_usd", "num"),
    F("api_fallback", "json", nullable=True),
    F("api_fallback_since", "json", nullable=True),
    F("api_fallback_until", "json", nullable=True),
    F("api_key", "json", nullable=True),
    F("cred_warned_at", "json", nullable=True),
    F("headless", "json", nullable=True),
    F("desktop_import", "json", nullable=True),
    F("op_receipts_meta", "json", nullable=True),
    F("tool_result_receipts", "json", nullable=True),
    # a removed feature's key, kept for the former-sandbox catch-up (mappers.KEPT_LEGACY)
    F("sandbox", "json", nullable=True),
    # read by older builds, written by none today (design §5.2 "106 keys")
    F("chain_notices", "json", nullable=True),
    F("release", "json", nullable=True),
))
