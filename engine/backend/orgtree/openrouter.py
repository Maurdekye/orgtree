# pyright: strict
"""OpenRouter — the first API-BACKED provider lane (user go-ahead 2026-09-02).

Every provider before this one was a CONNECTED LOCAL CLI: orgtree detected a
binary, read connect-state off the CLI's own auth store, and spawned the CLI
per turn. OpenRouter is none of that — it is a REST gateway
(https://openrouter.ai/api/v1, one Bearer API key) in front of ~425 models from
~70 upstream vendors, usage-billed against a prepaid credit balance. So this
module owns what a CLI would otherwise have owned:

  · the KEY (App settings → Providers is the only door; `key_set` is the
    "installed" fact and a cached `GET /api/v1/key` the "connected" one),
  · the CATALOG (`GET /api/v1/models`, cached on disk under
    <data>/openrouter/, searched server-side for the picker modal),
  · the FAVORITES (the user's curated list — user spec 2026-09-02: "those are
    the models that have tokens that can be hired"), and
  · the DYNAMIC TIERS the favorites become: tier id `or-<slugified model id>`,
    seat = the repo's standing rule (API $ per M INPUT tokens — floored to a
    whole number at or above $1, the price itself below it, `seat_for` /
    ledger.py §3.1), letter + color derived CANONICALLY from the model id so
    ~425 models never need a hand-picked palette.

⚠ SECRET HYGIENE. The key is stored in <data>/openrouter/state.json and NEVER
returned by any reader here: `status()` answers `key_set`, the /api/v1/key
LABEL and the credit figures, nothing else. The key reaches a child process
only through the execution lane's spawn env (supervisor), one credential per
spawn like every other lane.

⚠ NO NETWORK FROM IMPORT. Fetches happen lazily behind `_http_get`, which
tests replace (see backend/tests/test_openrouter.py) — the catalog rig is a
fabricated document, never openrouter.ai.

Tier ids are one flat vocabulary with every other provider's (providers.py):
the `or-` prefix is what keeps a favorite's id clear of fable/sol/flash and
lets `providers.provider_of` answer "openrouter" for it without a registry
lookup.

WHAT THE USER SEES IS NOT THE ID (user ask 2026-09-03: "remove the or- and
provider name prefix from openrouter model names"). Every surface prints the
`label` — the model id after its vendor namespace (`claude-sonnet-5`), the
`:free`-style variant suffix kept — and the `name` without its `Vendor: `
prefix (`Claude Sonnet 5`). The tier id and the full model id stay exactly
what they were everywhere they are stored, keyed or sent upstream; see
`model_label`, `pretty_name`, `labels_for` and `tier_label`.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from collections.abc import Iterable, Mapping
from typing import Any, Final, TypedDict, cast

from . import store

API_BASE: Final = "https://openrouter.ai/api/v1"
#: the Anthropic-compatible base Claude Code is pointed at (its own cookbook:
#: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`; the CLI appends /v1/messages)
ANTHROPIC_BASE: Final = "https://openrouter.ai/api"
TIER_PREFIX: Final = "or-"
STATE_FILE: Final = "state.json"
CATALOG_FILE: Final = "models.json"
STATE_VERSION: Final = 1
#: how long a downloaded catalog is trusted before a refetch is attempted; a
#: failed refetch falls back to the stale copy rather than an empty picker
CATALOG_TTL: Final = 3600.0
#: /api/v1/key is polled by the accounts panel; the same 60s cache the CLI
#: status probes use
KEY_TTL: Final = 60.0
HTTP_TIMEOUT: Final = 20.0
#: user ruling 2026-09-02 (ask card): NO cap on favorites — 0 means unlimited
#: (the family row wraps; the picker's selected strip grows). Kept as a knob
#: so a cap can be re-introduced without touching the add path.
FAVORITES_MAX: Final = 0
PROVIDER_ID: Final = "openrouter"
PROVIDER_LABEL: Final = "OpenRouter"

_LOCK = threading.RLock()


class OpenRouterError(RuntimeError):
    """A catalog or key request could not be satisfied (with a written why)."""


class ModelCard(TypedDict):
    """One catalog entry as the picker and the registry need it — prices in
    $ per MILLION tokens (the catalog publishes $ per token)."""
    id: str
    #: the display name without its `Vendor: ` prefix (`Claude Sonnet 5`)
    name: str
    #: the display id without its vendor namespace (`claude-sonnet-5`) — what
    #: every surface prints where it used to print the id or the tier
    label: str
    vendor: str
    prompt: float
    completion: float
    cache_read: float
    #: $/M for writing a prompt-cache entry — published for the vendors that
    #: charge it (Anthropic 1.25× input); absent ones fall back to the input
    #: price, which is what every automatic-caching vendor charges
    cache_write: float
    #: catalog price components that were absent/invalid. Numeric fields above
    #: stay present for old API consumers; this is the knowledge boundary.
    price_unknown: list[str]
    price_source: str
    context: int
    #: THREE-STATE, and the third state is the point. `True`/`False` are the
    #: catalog's own DECLARATION about tool support; `None` is "the catalog
    #: entry declared nothing we can read" — a missing, null, scalar or
    #: malformed `supported_parameters`, or a favorite recorded before this
    #: field existed. Conflating unknown with `False` would state a capability
    #: gap the catalog never claimed, and conflating it with `True` (what the
    #: legacy reader did until 2026-09-05) states support nothing declared.
    #: ⚠ A DECLARATION, NEVER AN OBSERVATION: no turn, tool call or refusal on
    #: any OpenRouter model is behind this value. Every surface that prints it
    #: says `(catalog)` for exactly that reason.
    tools: bool | None
    #: the catalog's IMAGE-INPUT declaration, the same three states and the
    #: same caveat: `architecture.input_modalities` names `image` (True), is
    #: a readable list that does not (False), or is unreadable (None). Read
    #: from the structured list, never the legacy `modality` display string.
    #: ⚠ Orgtree sends image content blocks to every Claude-CLI lane —
    #: OpenRouter included — with no regard to this value; it discloses what
    #: the catalog says and changes no delivery. Unit C, 2026-09-05.
    image: bool | None
    #: whether `supported_parameters` names the `reasoning` REQUEST PARAMETER
    #: — three-state, same rule as `tools`. This is membership in a parameter
    #: list, not a claim about how a model thinks, which is why the UI prints
    #: "Reasoning parameter". The catalog also carries a top-level `reasoning`
    #: object; measured 2026-09-05 the two disagree on 7 of 431 rows, and this
    #: field reads the PARAMETER LIST by decision (the object is a later
    #: effort-control question). ⚠ `--effort` is passed on every OpenRouter
    #: turn regardless of this value; nothing here changes that.
    reasoning: bool | None
    free: bool
    #: the catalog's own release timestamp (unix seconds), 0 if absent. The
    #: ONE honest recency signal the catalog carries — see `sort_key`.
    created: int
    letter: str
    color: str
    #: the rim of a DARK chip (`accent_for`), None for every light colour
    accent: str | None


class Favorite(ModelCard):
    tier: str
    seat: float          # fractional below $1/M (seat_for) — whole at/above it
    added_at: str


class CostDetail(TypedDict):
    amount: float
    source: str
    unknown_fields: list[str]


# ── paths ──────────────────────────────────────────────────────────────────

def _dir() -> str:
    """Resolved per call: tests replace store.DATA_ROOT after import."""
    return os.path.join(store.DATA_ROOT, "openrouter")


def _state_path() -> str:
    return os.path.join(_dir(), STATE_FILE)


def _catalog_path() -> str:
    return os.path.join(_dir(), CATALOG_FILE)


def _atomic_write(target: str, blob: bytes) -> None:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
        for attempt in range(20):
            try:
                os.replace(tmp, target)
                tmp = ""
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.01 * (attempt + 1))
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass


# ── state: key + favorites ─────────────────────────────────────────────────

def _blank_state() -> dict[str, Any]:
    return {"version": STATE_VERSION, "key": "", "favorites": []}


#: the ledger's org-doc migration merges `tiers()`/`models()` on EVERY
#: `load_org`, which runs per API call — so the state file is read behind a
#: short mtime-keyed cache (the env_overrides precedent, ~2s), not per call.
_state_cache: dict[str, Any] = {"at": 0.0, "mtime": None, "path": "", "doc": None}
_STATE_TTL: Final = 2.0


def _load_state() -> dict[str, Any]:
    with _LOCK:
        p = _state_path()
        now = time.time()
        cached = _state_cache.get("doc")
        if (cached is not None and _state_cache["path"] == p
                and now - float(_state_cache["at"]) < _STATE_TTL):
            return json.loads(json.dumps(cached))
        try:
            mtime: float | None = os.stat(p).st_mtime
        except OSError:
            mtime = None
        if cached is not None and _state_cache["path"] == p \
                and mtime == _state_cache["mtime"]:
            _state_cache["at"] = now
            return json.loads(json.dumps(cached))
        raw: Any = None
        try:
            with open(p, encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, json.JSONDecodeError):
            raw = None
        out = _blank_state()
        doc: dict[str, Any] = cast("dict[str, Any]", raw) if isinstance(raw, dict) else {}
        if doc.get("version") == STATE_VERSION:
            key = doc.get("key")
            out["key"] = key if isinstance(key, str) else ""
            favs = doc.get("favorites")
            out["favorites"] = [
                cast("dict[str, Any]", f)
                for f in cast("list[Any]", favs) if isinstance(f, dict)] \
                if isinstance(favs, list) else []
        _state_cache.update({"at": now, "mtime": mtime, "path": p,
                             "doc": json.loads(json.dumps(out))})
        return out


def _save_state(doc: dict[str, Any]) -> None:
    doc["version"] = STATE_VERSION
    _atomic_write(_state_path(),
                  json.dumps(doc, indent=2).encode("utf-8"))
    with _LOCK:
        _state_cache["doc"] = None


def _key() -> str:
    """The credential, for the SPAWN SEAM ONLY (supervisor injects it into
    one child's env). Never serialize its return value."""
    return str(_load_state().get("key") or "")


def key_set() -> bool:
    return bool(_key())


def set_key(key: str) -> None:
    """Store (or, with an empty string, clear) the machine-wide key. Clearing
    also drops the cached /api/v1/key verdict so the panel cannot keep
    showing the old key's credits."""
    global _key_cache
    k = (key or "").strip()
    if k and not re.fullmatch(r"[A-Za-z0-9_\-\.]{8,512}", k):
        raise OpenRouterError("that does not look like an OpenRouter API key")
    with _LOCK:
        doc = _load_state()
        doc["key"] = k
        _save_state(doc)
        _key_cache = None


# ── the catalog ────────────────────────────────────────────────────────────

def _default_http_get(url: str, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return int(r.status), r.read()
    except urllib.error.HTTPError as e:
        return int(e.code), e.read() if e.fp else b""


#: the ONE network door — tests replace it with a scripted stand-in
_http_get = _default_http_get


def _ua_headers() -> dict[str, str]:
    return {"User-Agent": "orgtree (+https://github.com/neoja/claude-orgtree)",
            "X-OpenRouter-Title": "orgtree"}


def vendor_of(model_id: str) -> str:
    return model_id.split("/", 1)[0] if "/" in model_id else "openrouter"


# ── display names (2026-09-03) ─────────────────────────────────────────────
#
# DISPLAY ONLY. Nothing below is ever stored as a key, compared to a catalog
# id, or sent to openrouter.ai: the full `vendor/model[:variant]` id stays the
# identity everywhere, these are what the user reads.

def model_label(model_id: str) -> str:
    """The id after its vendor namespace: `anthropic/claude-sonnet-5` →
    `claude-sonnet-5`, `z-ai/glm-5.2:free` → `glm-5.2:free`. The variant
    suffix is KEPT: it is a different model at a different price, and
    dropping it would fold 74 pairs of the live catalog's 425 rows into one
    name each (measured 2026-09-03), where keeping it folds none."""
    return model_id.split("/", 1)[1] if "/" in model_id else model_id


#: the catalog's `Vendor: ` name prefix — one short run before the first
#: colon, never a parenthesised qualifier (`Claude Sonnet 5 (batch)` keeps
#: its parenthesis, `SpaceXAI: Grok 4.6` loses its vendor)
_NAME_PREFIX: Final = re.compile(r"^[^:()]{1,40}:\s+")


def pretty_name(name: str, model_id: str) -> str:
    """The catalog's display name without its vendor prefix: `Anthropic:
    Claude Sonnet 5` → `Claude Sonnet 5`. Measured on the live catalog
    2026-09-03: 398 of 425 names carry the prefix, it is constant per vendor,
    and stripping it leaves no two names equal. An empty name falls back to
    the label so the picker never shows a blank row."""
    n = (name or "").strip()
    if not n:
        return model_label(model_id)
    return _NAME_PREFIX.sub("", n, count=1) or n


def labels_for(ids: Iterable[str]) -> dict[str, str]:
    """Labels for one DISPLAYED SET of model ids. Each gets its short label
    unless another id in the SAME set would read the same — then both keep
    their full id, so the user is never shown two identical rows. The live
    catalog has no such pair today (0 of 425 with the variant suffix kept);
    a set is still disambiguated against itself, never against a catalog
    that may not be loaded (favorites are read on every org load, offline
    or not)."""
    ids = list(ids)
    short = {i: model_label(i) for i in ids}
    counts = Counter(short.values())
    return {i: (i if counts[s] > 1 else s) for i, s in short.items()}


def tier_id(model_id: str) -> str:
    """`or-` + the model id with every non-alphanumeric run folded to `-`
    (`anthropic/claude-sonnet-5` → `or-anthropic-claude-sonnet-5`). Safe as a
    CSS class fragment, a URL segment and a JSON key, and always clear of the
    static tier vocabulary by its prefix."""
    return TIER_PREFIX + re.sub(r"[^a-z0-9]+", "-", model_id.lower()).strip("-")


def is_tier(tier: str) -> bool:
    return tier.startswith(TIER_PREFIX)


#: the smallest seat a model may cost, and the grid every fractional seat is
#: quantised to (ledger.SEAT_FLOOR / ledger.CREDIT_QUANTUM carry the same
#: numbers for the ledger's own arithmetic; they are re-stated here rather
#: than imported because openrouter must not import ledger).
SEAT_FLOOR: Final = 0.10
SEAT_QUANTUM: Final = 2          # decimal places — the 0.01 grid

#: the floor the rule carried BEFORE 2026-09-03 (`max(1, floor(p))`), and so
#: the only value a stale row can hold — `legacy_seat_for` proves it.
LEGACY_FLOOR: Final = 1.0


def seat_for(prompt_per_m: float) -> float:
    """The standing seat rule (ledger.py §3.1), extended below $1 (user
    ruling 2026-09-03). API $ per M INPUT tokens:

        seat(p) = floor(p)                     when p >= 1
                = max(0.10, round(p, 2))       when p <  1

    sol $5 → 5, terra $2 → 2, flash $1.50 → 1 (UNCHANGED — at or above $1 the
    old floor still governs, so no tier that already exists is re-priced and
    no saved org can become overdrawn), gpt-reserve/luna $0.20 → 0.2,
    gemini-3.8-flash $0.75 → 0.75, a $0.02 model → 0.1.

    ⚠ THE 0.10 FLOOR IS LOAD-BEARING, NOT COSMETIC. OpenRouter's catalog
    carries `:free` variants that price at $0.00/M, and the old rule's
    `max(1, …)` was the only thing standing between them and a seat of ZERO.
    A zero seat bounds nothing: `free(N) = grant(N) − Σ(seat + grant)` never
    decreases when you hire one, so an org could spawn such agents without
    limit — each a real OS process — with MAX_CHILDREN as the only brake.
    Credits are OCCUPANCY, not spend (ledger.py's opening note: "a credit is
    not a dollar"), so a seat that costs nothing is a contradiction in the
    allocator's own terms. At 0.10 the cheapest model on the market still
    admits at most ten agents per haiku-equivalent."""
    if prompt_per_m >= 1.0:
        return float(math.floor(prompt_per_m + 1e-9))
    return max(SEAT_FLOOR, round(prompt_per_m, SEAT_QUANTUM))


def legacy_seat_for(prompt_per_m: float) -> float:
    """The seat rule AS IT SHIPPED BEFORE 2026-09-03: `max(1, floor(p))`.

    Kept as executable history because it is the only way to tell an old
    SHIPPED DEFAULT from an operator's own price, which is the one thing a
    repricing migration is not allowed to get wrong (ledger.py's sonnet-3→2
    precedent: "Only the OLD SHIPPED DEFAULT migrates").

    ☞ THE TWO RULES DIFFER IN EXACTLY ONE PLACE, and that is what makes a
    general migration possible without a list of tier names. At or above $1
    both are `floor(p)` — identical, so no tier priced ≥$1/M can be stale.
    Below $1 the old rule collapses EVERY price to 1 and the new one spreads
    them over [0.10, 0.99]. So a stale row is exactly: value == 1 AND the
    model prices under $1/M. Nothing else can be stale, and a row at any
    other value was set by hand."""
    return max(1.0, float(math.floor(prompt_per_m + 1e-9)))


def _seat_of(rec: Mapping[str, Any]) -> float:
    """A favorite record's seat, with the pre-2026-09-03 floor migrated away.

    The seat is recomputed from the record's OWN SNAPSHOT price, never from
    the live catalog, so this cannot re-price a committed seat when a model's
    list price moves later — the property `add_favorite` snapshots for. It is
    the RULE that changed, not the price, and re-deriving it here is the same
    move the `letter`/`color` fields already make just below: a rule change
    reaches favorites added under the old rule without a migration file.

    An operator who hand-edited a seat in state.json keeps it: only a value
    the OLD rule would itself have produced for this very price is replaced.
    (`add_favorite` is the only writer of `seat` in this module, so today
    that guard protects a case that does not yet arise — it is here so the
    add-only discipline survives the first time one does.)"""
    p = float(rec.get("prompt") or 0.0)
    raw = rec.get("seat")
    if raw is None:
        return seat_for(p)
    try:
        seat = float(raw)
    except (TypeError, ValueError):
        return seat_for(p)
    return seat_for(p) if seat == legacy_seat_for(p) else seat


def letter_for(model_id: str) -> str:
    """The chip glyph: the first letter of the FIRST word of the model's
    display label (user ask 2026-09-03, verbatim: "base the model card icon
    letter off the first word (ignoring the or and provider name that we are
    dropping) not the last word"). claude-sonnet-5 → C · gpt-5.6-sol → G ·
    gemini-3.5-flash → G · grok-4.6 → G · deepseek-v4 → D · kimi-k3 → K ·
    llama-4-maverick → L · glm-5.2:free → G.

    ⚠ THE LETTER IS A FAMILY GLYPH NOW, NOT A DISCRIMINATOR. The first cut
    keyed off the last meaningful token, so sonnet/opus/haiku read S/O/H;
    this rule reads every claude-* as C and gpt-*, grok-*, gemini-* and glm-*
    all as G. The COLOR — the vendor hue, or the xAI black — is what tells
    such cards apart; no tie-breaker is applied, by instruction."""
    label = model_label(model_id).split(":", 1)[0]
    toks = [t for t in re.split(r"[-_./ ]+", label.lower()) if t]
    return (toks[0][:1].upper() if toks else "") or "?"


#: canonical hue per vendor (degrees, OKLCH). Since 2026-09-03 the hues are
#: BRAND-SOURCED where a first-party value exists (brand-colors-2 research:
#: each vendor's own site CSS, logo SVG or theme-color tag; the data sits in
#: the researcher's brand-colors.json), the three CLI lanes stay on the desk
#: themes the app already wears (--prov-claude terracotta, --prov-openai
#: teal, --prov-google blue-violet), and the rest are PLACEHOLDERS — never
#: researched (brand-colors-2 found no first-party value for ai21, microsoft
#: or liquid; the others were out of its scope) — slotted into the gaps the
#: researched hues leave, so a placeholder never sits on a brand hue and
#: never looks researched. Anyone missing hashes to a hue instead.
#:
#: ⚠ THE BLUE CLUSTER. Six researched brands are the SAME blue to within a
#: few degrees — Meta #0082FB 255°, Kimi #1783FF 256°, Amazon Nova #0066FF
#: 261°, IBM Blue-60 #0F62FE 262°, Cohere #4C6EE6 268°, DeepSeek #4D6BFE
#: 270° — and Google's lane sits at 262° between them, so hue fidelity and
#: legibility cannot both be had: six chips 1–4° apart are one chip. What is
#: shipped instead: the cluster is SPREAD over 228°–304° in BRAND ORDER (a
#: vendor keeps its neighbours and its side of Google, and moves at most
#: ~20°), Google's 262° is the fixed point in the middle, every vendor is
#: ≥ 8° from its neighbours, neighbours alternate CHROMA (`_VENDOR_CHROMA`
#: below: a periwinkle brand is minted soft, an electric one full, so an
#: adjacent pair differs in saturation as well as hue), and the per-model
#: nudge is ±2° so it cannot eat the spacing. IBM takes the Granite page's
#: own Carbon Purple-60 (#8A3FFC, 295°) rather than its Blue-60: Blue-60 is
#: 1° from Amazon Nova AND on Google's hue, and granite-* shares the G glyph
#: with gemini-*, so on Blue-60 a Granite chip and a Gemini chip would be the
#: same chip. What still tells the six apart at chip size is the LETTER —
#: llama L, kimi K, nova N, granite G, command C, deepseek D are all
#: different — and the palette leans on that: colour places a chip in the
#: cyan-blue / electric / periwinkle-violet third of the family, the letter
#: names the vendor. Two brand twins (Amazon Nova / IBM Blue-60, 1° apart in
#: the brands' own hexes) were never going to be told apart by colour.
#:
#: Mistral is orange-red #FA500F (37°) — NOT blue — and 37° is Anthropic's
#: terracotta, so it wears the orange step of its own red→orange→yellow ramp
#: (#ff8204, 54°). Qwen is violet #615CED (279°), deliberately not parent
#: Alibaba's orange. Perplexity's True Turquoise #20808D is a MUTED teal
#: (chroma .09), minted soft to stay so. Nvidia #76B900 is exact.
_VENDOR_HUE: Final[dict[str, int]] = {
    # the CLI lanes (fixed, the desk themes)
    "anthropic": 40, "openai": 175, "google": 262,
    # brand-sourced (brand-colors-2, 2026-09-03; brand hue → slot)
    "mistralai": 54,       # #ff8204 orange step of the #FA500F ramp (37° is Claude's)
    "nvidia": 131,         # #76B900, exact
    "perplexity": 209,     # #20808D True Turquoise, exact (soft)
    "reka": 228,           # #00BFFF 232°
    "meta-llama": 238,     # #0082FB 255°, the cyan-leaning end of the cluster
    "moonshotai": 246,     # #1783FF 256°
    "amazon": 254,         # #0066FF 261°
    "cohere": 272,         # #4C6EE6 268° (soft)
    "deepseek": 282,       # #4D6BFE 270°
    "qwen": 292,           # #615CED 279°
    "ibm-granite": 304,    # #8A3FFC Carbon Purple-60 295° (see above), not Blue-60
    "ibm": 304,
    # placeholders — NOT researched; in the gaps the brand hues leave
    "xiaomi": 15, "ai21": 80, "inception": 95, "nousresearch": 105,
    "liquid": 160, "microsoft": 190, "bytedance": 320, "baidu": 335,
    "tencent": 350, "openrouter": 0,
}


#: the second axis inside the blue cluster: a chroma SCALE on the price band's
#: chroma (1.0 when absent). Soft = the brand is the softer one of a pair
#: (Meta's #0082FB sits at L .62 against Kimi's electric #1783FF; Cohere's
#: #4C6EE6 is C .19 against DeepSeek's .22; Perplexity's turquoise is C .09),
#: full/plus = the electric brands (Amazon Nova and Qwen are the most
#: saturated hexes in the set). Neighbours in the table above alternate, so
#: an adjacent pair differs in saturation as well as hue.
_VENDOR_CHROMA: Final[dict[str, float]] = {
    "perplexity": 0.7, "meta-llama": 0.8, "amazon": 1.1, "cohere": 0.7,
    "qwen": 1.1,
}


#: the model-to-model hue nudge, degrees either side of the vendor hue (was
#: ±12° when the table was hand-spread; brand slots 8° apart cannot afford
#: it — two neighbours nudged toward each other still keep ≥ 4°). Siblings
#: are told apart by their band and their label; this is a courtesy.
_MODEL_NUDGE: Final = 2.0


#: vendors whose canonical look is DARK: hue, chroma, and the lightness of
#: the dearest and the cheapest price band (OKLCH). Still banded by price like
#: every other vendor but compressed into near-blacks, every band darker
#: than the panel (#252526) a card sits on — so the frontend renders them
#: FILLED (colour = background, letter in the UI's strong ink, a rim keeps
#: the edge off the background: shared.ts `openrouterTierCss`, styles.css
#: `.orr-card.dark`; `isDarkTierColor` decides by WCAG luminance < .03, so
#: every band here must stay under that — L .30 achromatic is #2e2e2e, .027).
#:   x-ai    — user ask 2026-09-03 "give xai models a black theme": achromatic
#:             #020202…#161616, no accent: pure black IS the identity.
#:   minimax — brand #181E25 (near-black navy, minimax.io CSS): the navy is
#:             deepened (chroma .04 against the brand's .016) so it reads as
#:             navy beside the xAI black, and rimmed with the brand's
#:             orange-red accent #FF5530 (⚠ third-party corroborated only,
#:             not seen on-domain by the researcher).
#:   z-ai    — no chromatic identity at all: the official logomark is neutral
#:             #2D2D2D (z-cdn.chatglm.cn), so the fill is that grey, banded
#:             #1e1e1e…#2e2e2e, and the rim is the cyan #00d4ff from z.ai's
#:             own decorative palette — ⚠ a DELIBERATE choice, not an official
#:             mark colour, taken so three dark vendors are not one dark chip.
#: The ACCENT (`_VENDOR_ACCENT`) is served beside the colour; the frontend
#: draws it as the rim of a dark chip and ignores it on a light one.
_DARK_VENDORS: Final[dict[str, tuple[int, float, float, float]]] = {
    "x-ai": (0, 0.0, 0.08, 0.20),
    "minimax": (252, 0.04, 0.15, 0.26),
    "z-ai": (0, 0.0, 0.23, 0.30),
}
_BLACK_VENDORS: Final = frozenset(_DARK_VENDORS)
_VENDOR_ACCENT: Final[dict[str, str]] = {
    "minimax": "#ff5530", "z-ai": "#00d4ff",
}


def _hash01(s: str) -> float:
    return int(hashlib.sha1(s.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF


def _oklch_hex(light: float, chroma: float, h_deg: float) -> str:
    """OKLCH → sRGB hex, reducing chroma until the color is in gamut."""
    h = math.radians(h_deg)
    for _ in range(24):
        a, b = chroma * math.cos(h), chroma * math.sin(h)
        l_ = light + 0.3963377774 * a + 0.2158037573 * b
        m_ = light - 0.1055613458 * a - 0.0638541728 * b
        s_ = light - 0.0894841775 * a - 1.2914855480 * b
        l, m, s = l_ ** 3, m_ ** 3, s_ ** 3
        r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
        g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
        bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
        if all(-1e-4 <= c <= 1 + 1e-4 for c in (r, g, bl)):
            def gam(c: float) -> int:
                c = min(1.0, max(0.0, c))
                v = 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
                return int(round(v * 255))
            return "#%02x%02x%02x" % (gam(r), gam(g), gam(bl))
        chroma *= 0.88
    return "#808080"


def color_for(model_id: str, prompt_per_m: float) -> str:
    """The canonical chip color (recommended scheme, ask card 2026-09-02):
    hue from the VENDOR (table above, hash fallback) nudged ±2° per model so
    siblings differ; LIGHTNESS from the price band — cheap models pale,
    expensive ones deep — the same lightness axis flash/pro and luna/sol
    already use, and the one axis colour-vision deficiency preserves; the
    band's chroma scaled per vendor (`_VENDOR_CHROMA`) where the blue cluster
    needs saturation as a second axis. Dark vendors take their own range."""
    vendor = vendor_of(model_id).lstrip("~")
    band = (3 if prompt_per_m >= 8.0 else 2 if prompt_per_m >= 3.0
            else 1 if prompt_per_m >= 1.0 else 0)
    dark = _DARK_VENDORS.get(vendor)
    if dark is not None:
        # the same four price bands, mapped onto the vendor's dark range: deep
        # (expensive) to merely very dark (cheap); no hue nudge — the dark
        # tone is the identity, the band is the only axis left
        hue, chroma, deep, pale = dark
        return _oklch_hex(deep + (pale - deep) * (3 - band) / 3, chroma, hue)
    base = _VENDOR_HUE.get(vendor)
    if base is None:
        base = int(_hash01("vendor:" + vendor) * 360)
    hue = (base + (_hash01("model:" + model_id) * 2 - 1) * _MODEL_NUDGE) % 360
    light, chroma = ((0.86, 0.10), (0.76, 0.13), (0.66, 0.16), (0.56, 0.17))[band]
    return _oklch_hex(light, chroma * _VENDOR_CHROMA.get(vendor, 1.0), hue)


def accent_for(model_id: str) -> str | None:
    """The chip's ACCENT, or None: a second colour served beside `color_for`
    for the vendors whose canonical look is dark (`_DARK_VENDORS`), where the
    fill alone cannot carry identity — the frontend draws it as the rim of a
    dark chip (shared.ts `openrouterTierCss`, styles.css `.orr-card.dark`)
    and ignores it on a light one. Pure function of the id, like the colour."""
    return _VENDOR_ACCENT.get(vendor_of(model_id).lstrip("~"))


_PRICE_FIELDS: Final = ("prompt", "completion", "cache_read", "cache_write")
_PRICE_SOURCES: Final = ("openrouter-catalog", "legacy-catalog-snapshot")


def _price_per_m(v: Any) -> tuple[float, bool]:
    """Compatibility numeric price plus whether the catalog actually said it."""
    try:
        if isinstance(v, bool):
            return 0.0, False
        out = float(v) * 1_000_000
        if not math.isfinite(out) or out < 0:
            return 0.0, False
        return round(out, 6), True
    except (TypeError, ValueError):
        return 0.0, False


def _per_m(v: Any) -> float:
    return _price_per_m(v)[0]


def _declared_tools(params: Any) -> bool | None:
    """The catalog's tool DECLARATION, or None when it declared nothing.

    ⚠ A VALID LIST OF STRINGS OR NOTHING. `supported_parameters` is a list of
    parameter names; anything else — absent, null, a scalar, a bool, a list
    with a non-string in it — is a shape this function cannot read, and an
    unreadable declaration is `unknown`, never `False`. "The catalog said the
    model does not take tools" and "the catalog said nothing we understand"
    are different facts and the UI prints them differently.

    ⚠ A LITERAL BOOL IS NOT A PARAMETER LIST. `True` is not "supports
    everything" here; it is a malformed `supported_parameters`, and reading it
    as a declaration would invent one. Normalized `tools` FIELDS are the only
    place a bool is meaningful — see `_stored_tools`.
    """
    return _declared_param(params, "tools")


def _declared_param(params: Any, name: str) -> bool | None:
    """Is `name` in the catalog's `supported_parameters` — three-state.

    The `_declared_tools` rule, by name: a valid list of strings is a
    declaration (`name` in it → True, not in it → False, and an EMPTY list is
    a declaration of nothing, so False); anything else is unknown. `reasoning`
    is read here as REQUEST-PARAMETER membership — `"reasoning" in the list`
    — and only that. `include_reasoning` and `reasoning_effort` ride beside
    it on every real row measured (304/304) and are deliberately NOT read: a
    reader of a neighbour would agree today and mean something else.
    """
    if not isinstance(params, list):
        return None
    items = cast("list[Any]", params)
    if not all(isinstance(p, str) for p in items):
        return None
    return name in items


def _declared_modality(arch: Any, name: str) -> bool | None:
    """Is `name` among the catalog's `architecture.input_modalities` —
    three-state, the same shape rule as `_declared_param`.

    ⚠ THE STRUCTURED LIST, NOT `architecture.modality`. That legacy string
    (`text+image+file->text`) agreed with the list on all 431 rows measured
    2026-09-05, but it is a display grammar and the list is the field; the
    test carries a row where the two disagree so a reader of the string is
    caught. A missing or non-dict `architecture`, or a missing / null /
    scalar / mixed `input_modalities`, is unknown — never "no image".
    """
    if not isinstance(arch, dict):
        return None
    mods = cast("dict[str, Any]", arch).get("input_modalities")
    if not isinstance(mods, list):
        return None
    items = cast("list[Any]", mods)
    if not all(isinstance(p, str) for p in items):
        return None
    return name in items


def _stored_tools(value: Any) -> bool | None:
    """A normalized `tools` field read back off a saved record.

    IDENTITY, not truthiness. `0`, `1`, `"true"`, `""` and every other
    near-miss are shapes this field never legitimately holds, so they read as
    unknown rather than being coerced into a declaration the record does not
    carry. `is True` / `is False` also keeps `1 == True` from smuggling an
    integer in as support.

    ⚠ A RECORD WITH NO KEY IS UNKNOWN. Until 2026-09-05 this defaulted to
    `True`, so every favorite adopted before the field existed claimed tool
    support that was never declared for it. Old rows are NOT rewritten: they
    stay exactly as saved and simply read as unknown.

    The same reader serves every stored three-state field (`tools`, `image`,
    `reasoning`): the rule is about the shape of a normalized bool-or-unknown
    record field, not about tools. Every favorite adopted before unit C
    (2026-09-05) has no `image`/`reasoning` key and reads unknown for both.
    """
    if value is True:
        return True
    if value is False:
        return False
    return None


def card_of(m: dict[str, Any]) -> ModelCard | None:
    """Normalize one raw catalog entry; None for entries the harnesses cannot
    run (batch variants, non-text output, unpriced)."""
    mid = str(m.get("id") or "")
    if not mid or mid.endswith(":batch"):
        return None
    arch_raw = m.get("architecture")
    arch: dict[str, Any] = (cast("dict[str, Any]", arch_raw)
                            if isinstance(arch_raw, dict) else {})
    outs_raw = arch.get("output_modalities")
    outs = cast("list[Any]", outs_raw) if isinstance(outs_raw, list) else []
    if outs and "text" not in outs:
        return None
    pricing_raw = m.get("pricing")
    pricing: dict[str, Any] = (cast("dict[str, Any]", pricing_raw)
                               if isinstance(pricing_raw, dict) else {})
    if not pricing:
        return None
    prompt, prompt_known = _price_per_m(pricing.get("prompt"))
    completion, completion_known = _price_per_m(pricing.get("completion"))
    cache_read, cache_read_known = _price_per_m(
        pricing.get("input_cache_read"))
    cache_write_raw, cache_write_known = _price_per_m(
        pricing.get("input_cache_write"))
    cache_write = cache_write_raw if cache_write_known else prompt
    price_unknown = [
        name for name, known in (
            ("prompt", prompt_known), ("completion", completion_known),
            ("cache_read", cache_read_known),
            ("cache_write", cache_write_known)) if not known]
    tools = _declared_tools(m.get("supported_parameters"))
    reasoning = _declared_param(m.get("supported_parameters"), "reasoning")
    # from the RAW architecture value, so a non-dict reads unknown rather
    # than the emptied `arch` above reading as "declared no image"
    image = _declared_modality(arch_raw, "image")
    try:
        ctx = int(m.get("context_length") or 0)
    except (TypeError, ValueError):
        ctx = 0
    try:
        created = int(m.get("created") or 0)
    except (TypeError, ValueError):
        created = 0
    return {
        "id": mid,
        "name": pretty_name(str(m.get("name") or ""), mid),
        "label": model_label(mid),
        "vendor": vendor_of(mid),
        "prompt": prompt,
        "completion": completion,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "price_unknown": price_unknown,
        "price_source": "openrouter-catalog",
        "context": ctx,
        "tools": tools,
        "image": image,
        "reasoning": reasoning,
        "created": created,
        "free": mid.endswith(":free") or (
            prompt_known and completion_known
            and prompt == 0 and completion == 0),
        "letter": letter_for(mid),
        "color": color_for(mid, prompt),
        "accent": accent_for(mid),
    }


_catalog_mem: dict[str, Any] = {"at": 0.0, "cards": None}


def _read_catalog_file() -> tuple[list[dict[str, Any]], float] | None:
    p = _catalog_path()
    raw: Any = None
    try:
        st = os.stat(p)
        with open(p, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return _rows_of(raw), st.st_mtime


def _rows_of(raw: Any) -> list[dict[str, Any]]:
    """The catalog document's `data` rows, or [] for any other shape."""
    doc: dict[str, Any] = cast("dict[str, Any]", raw) if isinstance(raw, dict) else {}
    data = doc.get("data")
    if not isinstance(data, list):
        return []
    return [cast("dict[str, Any]", d) for d in cast("list[Any]", data)
            if isinstance(d, dict)]


def refresh_catalog() -> list[ModelCard]:
    """Fetch the live catalog and bank it on disk. Raises OpenRouterError
    with the HTTP status or transport error spelled out."""
    try:
        status, body = _http_get(f"{API_BASE}/models", _ua_headers())
    except OSError as e:
        raise OpenRouterError(f"could not reach openrouter.ai: {e}") from None
    if status != 200:
        raise OpenRouterError(f"openrouter.ai answered {status} for the "
                              "model catalog")
    raw: Any = None
    try:
        raw = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise OpenRouterError("the model catalog was not JSON") from None
    if not (isinstance(raw, dict)
            and isinstance(cast("dict[str, Any]", raw).get("data"), list)):
        raise OpenRouterError("the model catalog had no `data` list")
    data = _rows_of(raw)
    _atomic_write(_catalog_path(), json.dumps({"data": data}).encode("utf-8"))
    cards = [c for c in (card_of(d) for d in data) if c]
    with _LOCK:
        _catalog_mem["at"] = time.time()
        _catalog_mem["cards"] = cards
    return cards


def catalog(force: bool = False) -> list[ModelCard]:
    """The normalized catalog: memory → fresh disk copy → network → STALE
    disk copy (better a day-old picker than an empty one) → error."""
    now = time.time()
    with _LOCK:
        cards = _catalog_mem.get("cards")
        if not force and cards is not None and now - float(_catalog_mem["at"]) < CATALOG_TTL:
            return list(cards)
    on_disk = _read_catalog_file()
    if not force and on_disk and now - on_disk[1] < CATALOG_TTL:
        cards = [c for c in (card_of(d) for d in on_disk[0]) if c]
        with _LOCK:
            _catalog_mem["at"] = on_disk[1]
            _catalog_mem["cards"] = cards
        return list(cards)
    try:
        return refresh_catalog()
    except OpenRouterError:
        if on_disk:
            cards = [c for c in (card_of(d) for d in on_disk[0]) if c]
            with _LOCK:
                _catalog_mem["at"] = now      # do not hammer a dead network
                _catalog_mem["cards"] = cards
            return list(cards)
        raise


#: the picker's sort vocabulary (user spec 2026-09-04: "sorting options
#: (recency of release, input price, output price)"). `relevance` is the
#: original ranking and stays the default, so an unsorted call behaves
#: exactly as it did before this existed.
SORTS: Final = ("relevance", "input", "output", "recency")
ORDERS: Final = ("asc", "desc")

#: rows per page. The original 5–10 clamp ENCODED A SPEC — "5–10 results at a
#: time", user spec 2026-09-02 — and it is gone: the user asked for more per
#: page on 2026-09-04 ("increase the results per page, and compress their
#: height so more can be fit onto the same page at once"), so the numbers
#: below are no longer a rule about what the picker should show.
#:
#: What remains is a PAYLOAD BOUND, which is a different thing and is why the
#: shape is kept at all: `PAGE_MAX` stops one request dragging the whole
#: 426-model catalog over the wire, and `PAGE_MIN` keeps a caller from asking
#: for 0 or 1 and turning the pager into 426 pages. Between them the caller
#: decides. Do not read these as a design opinion about page length — the
#: frontend's `PAGE` is that opinion, and it can move without touching this.
PAGE_DEFAULT: Final = 25
PAGE_MIN: Final = 5
PAGE_MAX: Final = 100


def _sort_key(sort: str, c: ModelCard) -> float:
    if sort == "input":
        return c["prompt"]
    if sort == "output":
        return c["completion"]
    return float(c["created"])          # recency


def search(q: str, offset: int = 0, limit: int = PAGE_DEFAULT,
           sort: str = "relevance", order: str = "",
           group_by_vendor: bool = False) -> dict[str, Any]:
    """The picker's page: every catalog card whose id or name contains EVERY
    whitespace-separated term of `q` (case-insensitive), ordered by `sort` and
    paged. `limit` is clamped to PAGE_MIN..PAGE_MAX — a payload bound, not a
    page-length rule; see the note on those constants.

    SORTS (user spec 2026-09-04). `relevance` — the original ranking: id
    matches before name matches, then the catalog's own order. `input` /
    `output` — $ per M prompt / completion tokens. `recency` — the catalog's
    `created` timestamp.

    ☞ RECENCY IS REAL, NOT INSERTION ORDER IN A COSTUME. That question was
    asked before this was built and the catalog was MEASURED to answer it:
    every one of the 426 models carries a `created` unix timestamp, 338
    distinct, spanning 2023-05-28 to 2026-09-02, none missing or zero. The
    catalog also ARRIVES in exact created-descending order (measured: zero
    inversions across all 425 adjacent pairs), so `recency desc` mostly
    LABELS the order the picker already had — `recency asc` is the new
    capability. Sorting on the field rather than on arrival order is still
    the right call: it keeps working the day OpenRouter stops pre-sorting,
    and nothing here would notice if it silently did.

    `order` defaults per sort — cheapest-first for a price, newest-first for
    recency — because that is the useful end in each case, and an unset
    direction should not mean "oldest models and dearest models".

    `group_by_vendor` (user spec: "a simple additional checkbox ... that's
    perpendicular to that dropdown") makes the VENDOR the primary key and the
    chosen sort secondary. Perpendicular is exactly right: it re-groups the
    same ordering rather than replacing it. Vendors are ordered by their own
    best row under the active sort, so the group order tracks the sort
    instead of being alphabetical against it.

    ⚠ EVERY ORDERING HERE IS TOTAL. The final key is always the model id, so
    no two rows can compare equal — 65 models share one context length and
    88 share a `created` value, and ties under a paged sort are how a row
    appears on two pages while another appears on none. `sorted` being stable
    is NOT enough: the list is re-sorted per request, so a tie broken by
    arrival order is only stable while the catalog is."""
    terms = [t for t in q.lower().split() if t]
    limit = max(PAGE_MIN, min(PAGE_MAX, int(limit or PAGE_DEFAULT)))
    offset = max(0, int(offset or 0))
    sort = sort if sort in SORTS else "relevance"
    if sort == "relevance":
        order = "asc"          # relevance has no direction: "worst match
        # first" is not a thing anyone wants, and offering it would be a
        # control that does nothing useful in one of its two positions
    elif order not in ORDERS:
        order = "asc" if sort in ("input", "output") else "desc"
    cards = catalog()
    hits: list[tuple[int, int, ModelCard]] = []
    for i, c in enumerate(cards):
        hay_id = c["id"].lower()
        hay_name = c["name"].lower()
        if all(t in hay_id or t in hay_name for t in terms):
            rank = 0 if all(t in hay_id for t in terms) else 1
            hits.append((rank, i, c))
    flip = -1.0 if order == "desc" else 1.0
    if sort == "relevance":
        hits.sort(key=lambda h: (h[0], h[1], h[2]["id"]))
    else:
        hits.sort(key=lambda h: (_sort_key(sort, h[2]) * flip, h[2]["id"]))
    if group_by_vendor:
        # each vendor takes the rank of its best row under the active sort, so
        # the groups march in the same direction the rows do
        best: dict[str, int] = {}
        for pos, h in enumerate(hits):
            best.setdefault(h[2]["vendor"], pos)
        hits.sort(key=lambda h: (best[h[2]["vendor"]], h[2]["vendor"]))
    fav_ids = {f["id"] for f in favorites()}
    # labels are disambiguated across the WHOLE result set, so a model reads
    # the same on every page of one query
    labels = labels_for(c["id"] for _, _, c in hits)
    page = [dict(c, selected=c["id"] in fav_ids, label=labels[c["id"]])
            for _, _, c in hits[offset:offset + limit]]
    return {"query": q, "offset": offset, "limit": limit,
            "total": len(hits), "items": page,
            "sort": sort, "order": order, "group_by_vendor": group_by_vendor,
            # ☞ an explicit sort DISPLACES the id-over-name relevance ranking,
            # and the picker says so rather than letting the rows quietly stop
            # answering what was typed. Only true when there is a query to
            # rank: with an empty box there is no relevance to lose.
            "relevance_displaced": bool(terms) and sort != "relevance",
            # the vendor of the row BEFORE this page, so a group heading split
            # across a page boundary can be drawn as "…continued"
            "prev_vendor": (hits[offset - 1][2]["vendor"]
                            if group_by_vendor and offset > 0
                            and offset - 1 < len(hits) else None)}


def find(model_id: str) -> ModelCard | None:
    """The card for MODEL_ID, FETCHING the catalog if that is what it takes.
    For a user action that can afford to wait (adopting a favorite). Callers
    on the turn path or a tree projection want `cached_card` instead."""
    for c in catalog():
        if c["id"] == model_id:
            return c
    return None


def cached_card(model_id: str) -> ModelCard | None:
    """The card for MODEL_ID from the in-memory catalog ONLY — never a disk
    read, never a fetch, no TTL refresh, no exception.

    ⚠ THIS EXISTS BECAUSE "THE CATALOG IS WARM" IS NOT "THE CATALOG IS
    LOCAL" (review finding, 2026-09-05). `find` goes through `catalog`,
    which returns the memory copy only while it is YOUNGER than
    CATALOG_TTL; past that it re-reads disk and, when the disk copy is
    stale or missing, calls `refresh_catalog` — an HTTP request, and on a
    dead network an OpenRouterError raised at the call site. A
    `_catalog_mem["cards"] is not None` guard in front of `find` does not
    prevent any of that: it only proves the process fetched once, an hour
    ago. This reads the snapshot under the lock and answers from it or not
    at all, so a caller that must not block and must not raise gets a plain
    None instead."""
    with _LOCK:
        cards = _catalog_mem.get("cards")
        snapshot = list(cards) if cards is not None else None
    if snapshot is None:
        return None
    for c in snapshot:
        if c["id"] == model_id:
            return c
    return None


# ── favorites → tiers ──────────────────────────────────────────────────────

def favorites() -> list[Favorite]:
    out: list[Favorite] = []
    for f in _load_state()["favorites"]:
        try:
            mid = str(f["id"])
            raw_unknown = f.get("price_unknown")
            if isinstance(raw_unknown, list) and all(
                    isinstance(x, str) and x in _PRICE_FIELDS
                    for x in raw_unknown):
                price_unknown = list(dict.fromkeys(raw_unknown))
                price_source = (str(f.get("price_source"))
                                if f.get("price_source") in _PRICE_SOURCES else
                                "openrouter-catalog")
            else:
                # Pre-provenance snapshots cannot establish that a stored zero
                # was a real quoted zero. Keep every numeric value unchanged,
                # but do not promote absence of evidence into "free".
                price_unknown = [
                    key for key in _PRICE_FIELDS
                    if key not in f or not float(f.get(key) or 0.0)]
                price_source = "legacy-catalog-snapshot"
            cache_write = (float(f.get("cache_write") or 0.0)
                           if "cache_write" in f
                           else float(f.get("prompt") or 0.0))
            out.append({
                "id": mid, "tier": str(f["tier"]),
                # the display forms are DERIVED on every read, never trusted
                # from the record: a favorite added before 2026-09-03 stored
                # `Anthropic: Claude Sonnet 5` and no label at all
                "name": pretty_name(str(f.get("name") or ""), mid),
                "label": model_label(mid),
                "vendor": str(f.get("vendor") or vendor_of(mid)),
                "prompt": float(f.get("prompt") or 0.0),
                "completion": float(f.get("completion") or 0.0),
                "cache_read": float(f.get("cache_read") or 0.0),
                # Key presence, not truthiness: explicit zero is a real price.
                "cache_write": cache_write,
                "price_unknown": price_unknown,
                "price_source": price_source,
                "context": int(f.get("context") or 0),
                # three-state: a record with no snapshot reads UNKNOWN, not as
                # a claim of support (`_stored_tools`). The saved row is never
                # rewritten to say so; it simply reads as unknown.
                "tools": _stored_tools(f.get("tools")),
                # unit C (2026-09-05): the same identity read; every favorite
                # adopted before it has neither key and reads unknown
                "image": _stored_tools(f.get("image")),
                "reasoning": _stored_tools(f.get("reasoning")),
                # 0 for a favorite adopted before the field was snapshotted —
                # only the CATALOG is ever sorted by recency, never this list
                "created": int(f.get("created") or 0),
                "free": (str(mid).endswith(":free") or (
                    "prompt" not in price_unknown
                    and "completion" not in price_unknown
                    and float(f.get("prompt") or 0.0) == 0.0
                    and float(f.get("completion") or 0.0) == 0.0)),
                # letter and color are CANONICAL — a pure function of the id
                # and the snapshot price — so they are recomputed on every
                # read: a rule change (the first-word letter, 2026-09-03)
                # reaches favorites added under the old rule without a
                # migration. The record's own copies are for older readers.
                "letter": letter_for(mid),
                "color": color_for(mid, float(f.get("prompt") or 0.0)),
                "accent": accent_for(mid),
                # a favorite snapshotted before 2026-09-03 carries the OLD
                # rule's floored seat — every model under $1/M recorded as 1.
                # `_seat_of` re-derives it from the record's own snapshot
                # price, so the fractional ruling reaches favorites added
                # before it (user ruling 2026-09-03, extended to OpenRouter
                # 2026-09-04). ⚠ THIS IS THE SOURCE OF TRUTH: `tiers()` is a
                # projection of it, so without this line even a BRAND NEW org
                # would still be handed the stale 1.
                "seat": _seat_of(f),
                "added_at": str(f.get("added_at") or ""),
            })
        except (KeyError, TypeError, ValueError):
            continue
    # the favorites are one displayed set (the hire surfaces): two that would
    # read the same keep their full ids
    labels = labels_for(x["id"] for x in out)
    for x in out:
        x["label"] = labels[x["id"]]
    return out


def add_favorite(model_id: str) -> Favorite:
    """Adopt a catalog model as a hireable tier. The seat and prices are
    SNAPSHOT here: a seat is a static table entry everywhere else in the
    ledger, and a favorite's price moving later must not silently re-price
    seats already committed in org docs (the sonnet-3→2 migration precedent
    says price changes are deliberate migrations, never drift)."""
    card = find(model_id)
    if card is None:
        raise OpenRouterError(f"{model_id!r} is not in the OpenRouter catalog")
    with _LOCK:
        doc = _load_state()
        favs: list[dict[str, Any]] = doc["favorites"]
        for f in favs:
            if f.get("id") == model_id:
                return favorites()[[x["id"] for x in favorites()].index(model_id)]
        if FAVORITES_MAX and len(favs) >= FAVORITES_MAX:
            raise OpenRouterError(
                f"at most {FAVORITES_MAX} favorites — deselect one first")
        rec: dict[str, Any] = dict(card)
        rec["tier"] = tier_id(model_id)
        rec["seat"] = seat_for(card["prompt"])
        rec["added_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        favs.append(rec)
        _save_state(doc)
    return favorites()[-1]


def remove_favorite(model_id: str) -> bool:
    """Drop a favorite from the hire surfaces. The tier row STAYS in any org
    doc that already carries it (add-only tables), so a node hired on it keeps
    its seat price and keeps running — deselecting is 'stop offering', never
    'evict'."""
    with _LOCK:
        doc = _load_state()
        before = len(doc["favorites"])
        doc["favorites"] = [f for f in doc["favorites"] if f.get("id") != model_id]
        if len(doc["favorites"]) == before:
            return False
        _save_state(doc)
    return True


def tiers() -> dict[str, float]:
    """tier id → seat, for every favorite (the dynamic half of ledger.TIERS)."""
    return {f["tier"]: f["seat"] for f in favorites()}


def stale_seats(doc_tiers: Mapping[str, float],
                doc_models: Mapping[str, str]) -> dict[str, float]:
    """{tier: corrected seat} for every OpenRouter row in an ORG DOCUMENT that
    still carries the pre-2026-09-03 shipped default. `ledger.Org` drives this
    on load; see the migration there for why a constant edit alone reaches no
    existing org.

    GENERAL BY CONSTRUCTION, NOT BY LIST. It takes the document's own tier and
    model tables and re-derives each row from its model's price, so a tier
    minted tomorrow is covered by the same code — the hard-coded
    `("gpt-reserve", "luna")` pair in ledger.py is precisely why the `or-*`
    rows were left behind, and repeating that shape would leave the next tier
    behind too.

    A row is a candidate ONLY at exactly 1 — see `legacy_seat_for` for the
    proof that the old and new rules cannot disagree anywhere else. That also
    bounds the cost: once a document has migrated there are no candidates, so
    the steady state below is a dict comprehension over the tier table and no
    I/O at all.

    ⚠ NEVER TOUCHES THE NETWORK. This runs inside a document load, so it
    reads the favorites snapshot (already TTL-cached) and, only if some
    candidate is not a current favorite — a DESELECTED tier keeps its row —
    the catalog file ON DISK. `catalog()` is deliberately not called: it
    falls through to an HTTP fetch, which has no business in a load hook.
    If neither source knows a model's price the row is LEFT ALONE and
    migrates on a later load once the catalog is on disk; a wrong guess is
    worse than a late one, because a model priced $1.00–$1.99/M is correctly
    at 1 already and must not move."""
    cands = [t for t, v in doc_tiers.items()
             if is_tier(t) and _as_float(v) == LEGACY_FLOOR]
    if not cands:
        return {}
    prices: dict[str, float] = {f["id"]: f["prompt"] for f in favorites()}
    if any(doc_models.get(t, "") not in prices for t in cands):
        on_disk = _read_catalog_file()
        for row in (on_disk[0] if on_disk else []):
            mid = str(row.get("id") or "")
            pricing = row.get("pricing")
            if mid and mid not in prices and isinstance(pricing, dict):
                prices[mid] = _per_m(cast("dict[str, Any]", pricing).get("prompt"))
    out: dict[str, float] = {}
    for t in cands:
        p = prices.get(doc_models.get(t, ""))
        if p is None:
            continue                     # unpriced here — try again next load
        # ⚠ THE PREFILTER IS NOT THE TEST. A row at 1 is only the old SHIPPED
        # DEFAULT if the old rule would have produced 1 for THIS model's
        # price; a $5/M model sitting at 1 was floored to 5 by the old rule
        # too, so its 1 is an operator's own price and must stay. Caught by
        # test_openrouter §4b, which asserted the wrong thing first.
        if legacy_seat_for(p) == LEGACY_FLOOR and seat_for(p) != LEGACY_FLOOR:
            out[t] = seat_for(p)
    return out


def _as_float(v: object) -> float:
    try:
        return float(cast("Any", v))
    except (TypeError, ValueError):
        return float("nan")


def models() -> dict[str, str]:
    """tier id → OpenRouter model id (the dynamic half of ledger.MODELS)."""
    return {f["tier"]: f["id"] for f in favorites()}


def contexts() -> dict[str, int]:
    return {f["tier"]: f["context"] for f in favorites() if f["context"]}


def favorite_for_tier(tier: str) -> Favorite | None:
    for f in favorites():
        if f["tier"] == tier:
            return f
    return None


def tier_label(tier: str, models: Mapping[str, Any] | None = None) -> str:
    """The display name of a TIER id — what a message prints where it used
    to print `or-anthropic-claude-sonnet-5`. A current favorite answers from
    the registry; a DESELECTED one from the org doc's own tier→model table
    (`models`, which the ledger hook merges add-only, so a node still running
    on it keeps its short name); anything else falls back to the slug without
    its `or-` prefix. A static tier passes through untouched."""
    if not is_tier(tier):
        return tier
    f = favorite_for_tier(tier)
    if f is not None:
        return f["label"]
    mid = (models or {}).get(tier)
    if isinstance(mid, str) and mid:
        return model_label(mid)
    return tier[len(TIER_PREFIX):]


def context_for(tier: str, models: Mapping[str, Any] | None = None) -> int | None:
    """The context window of an OpenRouter TIER, or None when nothing local
    knows it. The `tier_label` idiom, applied to a number.

    ⚠ A DESELECTED FAVORITE IS NOT A FORGOTTEN ONE (audit finding C-1,
    2026-09-05). Deselecting is "stop offering", never "evict": the org's
    tier table is add-only, so a node hired on that tier keeps running on it.
    Until now the window was read from the favorites registry alone, so the
    moment the favorite went away the seat's window silently became unknown
    and every surface fell back to the CLI's number — which this codebase
    already measured under-reporting 1M models as 200k. Nobody would connect
    a shrunken context bar back to a deselection.

    Resolution, in order:
      1. the current favorite's snapshot — unchanged, and still the answer
         for every selected tier;
      2. the org doc's own tier→model table (`models`, merged add-only by the
         ledger hook — the same retained mapping `tier_label` reads), then the
         LOCAL catalog card for that model id;
      3. None.

    ⚠ NO NETWORK, EVER. Step 2 goes through `cached_card`, which reads the
    in-memory catalog snapshot and nothing else: this runs on the turn path
    and on every tree projection, and a fetch there would put an HTTP call
    behind a context bar. Unknown here means the snapshot is MISSING, not
    that it is old — `cached_card` ignores CATALOG_TTL, so a warm process
    whose catalog has aged past it still answers with the window it knows,
    deliberately: a stale window is worth more than no window, and going and
    asking is the one thing this path may not do. Only a cold process — one
    that has never loaded the catalog — answers None, and None is honest.
    (An earlier draft guarded `find` with `_catalog_mem["cards"] is not
    None`; that guard is not enough, see `cached_card`.)

    ⚠ AND IT NEVER INVENTS A SIZE. No default window, no "probably 200k".
    A model the local catalog does not carry stays unknown, which is what
    the caller's existing observed-value fallback is for.
    """
    if not is_tier(tier):
        return None
    f = favorite_for_tier(tier)
    if f is not None:
        return f["context"] or None
    mid = (models or {}).get(tier)
    if not isinstance(mid, str) or not mid:
        return None
    card = cached_card(mid)
    return (card["context"] or None) if card is not None else None


def cost_detail(model_id: str, inp: int, cached: int, out: int,
                cache_write: int = 0) -> CostDetail:
    """Dollars plus price knowledge for one turn at its catalog snapshot.

    The amount is the old numeric estimate (including disclosed fallbacks), so
    callers that only understand a float keep their arithmetic. Unknown fields
    are reported only when that component consumed tokens.

    Prices come from the favorite snapshot
    prices (or the live card's, for a model that is no longer a favorite).
    `inp` is the NON-cached, non-cache-writing input (Anthropic's own
    accounting, which is what Claude Code's result `usage` reports:
    input_tokens · cache_read_input_tokens · cache_creation_input_tokens ·
    output_tokens); callers that get an inclusive input count subtract the
    cached reads first (codex_cost's measured convention)."""
    rec: dict[str, Any] | None = None
    for f in favorites():
        if f["id"] == model_id:
            rec = dict(f)
            break
    if rec is None:
        # ⚠ LOCAL ONLY. This is per-turn accounting: it must not block on
        # HTTP and must not raise when openrouter.ai is unreachable. The old
        # `find(...) if _catalog_mem["cards"] is not None` guard did both
        # once the warm copy aged past CATALOG_TTL — see `cached_card`.
        c = cached_card(model_id)
        if c is None:
            used = [("prompt", inp), ("cache_read", cached),
                    ("cache_write", cache_write), ("completion", out)]
            return {"amount": 0.0, "source": "unpriced",
                    "unknown_fields": [k for k, n in used if max(n, 0) > 0]}
        rec = dict(c)
    p_in = float(rec.get("prompt") or 0.0)
    p_cached = float(rec.get("cache_read") or 0.0)
    p_write = (float(rec.get("cache_write") or 0.0)
               if "cache_write" in rec else p_in)
    p_out = float(rec.get("completion") or 0.0)
    unknown_raw = rec.get("price_unknown")
    unknown = ({str(x) for x in unknown_raw if str(x) in _PRICE_FIELDS}
               if isinstance(unknown_raw, list) else set())
    used = [("prompt", inp), ("cache_read", cached),
            ("cache_write", cache_write), ("completion", out)]
    return {
        "amount": round((max(inp, 0) * p_in + max(cached, 0) * p_cached
                         + max(cache_write, 0) * p_write
                         + max(out, 0) * p_out) / 1e6, 6),
        "source": "catalog-snapshot",
        "unknown_fields": [k for k, n in used
                           if max(n, 0) > 0 and k in unknown],
    }


def cost(model_id: str, inp: int, cached: int, out: int,
         cache_write: int = 0) -> float:
    """Compatibility float wrapper for callers predating cost provenance."""
    return cost_detail(model_id, inp, cached, out, cache_write)["amount"]


# ── key status (credits) ───────────────────────────────────────────────────

_key_cache: tuple[float, dict[str, Any]] | None = None


def key_status(force: bool = False) -> dict[str, Any]:
    """`GET /api/v1/key` — the label and CREDIT standing of the stored key,
    never the key. connected: True (200) · False (401/403, the key is
    rejected) · None (no key, or the network did not answer — unknown is
    not the same as rejected, and the panel says which)."""
    global _key_cache
    now = time.time()
    if not force and _key_cache and now - _key_cache[0] < KEY_TTL:
        return dict(_key_cache[1])
    k = _key()
    out: dict[str, Any] = {
        "key_set": bool(k), "connected": None, "label": None,
        "limit": None, "limit_remaining": None, "limit_reset": None,
        "usage": None, "usage_daily": None, "usage_weekly": None,
        "usage_monthly": None, "is_free_tier": None,
        "total_credits": None, "total_usage": None,
        "reason": None, "checked_at": None,
    }
    if not k:
        out["reason"] = "no API key — add one in App settings → Providers"
        return out
    try:
        status, body = _http_get(f"{API_BASE}/key", {
            **_ua_headers(), "Authorization": f"Bearer {k}"})
    except OSError as e:
        out["reason"] = f"could not reach openrouter.ai: {e}"
        _key_cache = (now, out)
        return dict(out)
    out["checked_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now))
    if status in (401, 403):
        out["connected"] = False
        out["reason"] = ("the stored key was rejected by openrouter.ai — "
                         "replace it in App settings → Providers")
    elif status != 200:
        out["reason"] = f"openrouter.ai answered {status} for the key check"
    else:
        raw: Any = None
        try:
            raw = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raw = None
        doc: dict[str, Any] = (cast("dict[str, Any]", raw)
                                if isinstance(raw, dict) else {})
        data_raw = doc.get("data")
        if isinstance(data_raw, dict):
            data = cast("dict[str, Any]", data_raw)
            out["connected"] = True
            for f in ("label", "limit", "limit_remaining", "limit_reset",
                      "usage", "usage_daily", "usage_weekly",
                      "usage_monthly", "is_free_tier"):
                out[f] = data.get(f)
            # GET /api/v1/credits — OpenRouter's official docs claim this
            # endpoint requires a management key and 403s for a normal inference
            # key, but testing directly against a real inference key on this
            # machine returned 200 with real data (total_credits, total_usage),
            # verified 2026-09-03. This provides the authoritative prepaid
            # balance (total_credits - total_usage) for uncapped keys.
            try:
                c_status, c_body = _http_get(f"{API_BASE}/credits", {
                    **_ua_headers(), "Authorization": f"Bearer {k}"})
                if c_status == 200:
                    c_raw = json.loads(c_body.decode("utf-8"))
                    if isinstance(c_raw, dict) and isinstance(c_raw.get("data"), dict):
                        c_data = cast("dict[str, Any]", c_raw["data"])
                        out["total_credits"] = c_data.get("total_credits")
                        out["total_usage"] = c_data.get("total_usage")
            except Exception:
                pass
        else:
            out["reason"] = "the key check answered without a `data` record"
    _key_cache = (now, out)
    return dict(out)


def cached_key_status() -> dict[str, Any] | None:
    """The last `GET /api/v1/key` answer, or None — NEVER fetches. For a
    cache-only read (the header glow, the dynamic turn envelope) that must
    not spend a request the ordinary 60s poll has not already paid for. See
    `openrouter_limits`, which is the one caller."""
    if _key_cache is None:
        return None
    return dict(_key_cache[1])


def key_status_age() -> float | None:
    """Seconds since the cached `/api/v1/key` answer arrived, or None when
    nothing is cached yet."""
    if _key_cache is None:
        return None
    return time.time() - _key_cache[0]


def forget_key_status() -> None:
    """Drop the cached `/api/v1/key` answer (tests; `set_key` already does
    this as a side effect of a key replacement)."""
    global _key_cache
    _key_cache = None


def status(force: bool = False) -> dict[str, Any]:
    """The provider-status document for /api/providers and the panel: the
    CLI providers' `installed`/`connected` vocabulary, mapped honestly —
    installed = a key is stored; connected = openrouter.ai accepted it."""
    ks = key_status(force)
    favs = favorites()
    return {
        "installed": bool(ks["key_set"]),
        "connected": ks["connected"] is True,
        "key_set": bool(ks["key_set"]),
        "kind": "api-key" if ks["key_set"] else None,
        "email": None,
        "label": ks["label"],
        "credits": {k: ks[k] for k in (
            "limit", "limit_remaining", "limit_reset", "usage", "usage_daily",
            "usage_weekly", "usage_monthly", "is_free_tier", "total_credits",
            "total_usage", "checked_at")
            if k in ks},
        "reason": ks["reason"],
        "favorites": len(favs),
        "favorites_max": FAVORITES_MAX,
    }


def tier_infos() -> list[dict[str, Any]]:
    """The `tiers` list of the /api/providers entry — one row per favorite,
    in the user's own order, carrying everything a hire surface draws."""
    return [{
        "tier": f["tier"], "provider": PROVIDER_ID, "seat": f["seat"],
        "model": f["id"], "letter": f["letter"], "color": f["color"],
        "accent": f["accent"],
        "name": f["name"], "label": f["label"], "vendor": f["vendor"],
        "prompt": f["prompt"], "completion": f["completion"],
        "price_unknown": f["price_unknown"],
        "price_source": f["price_source"],
        "context": f["context"],
        # the catalog's tool DECLARATION, three-state (`ModelCard.tools`).
        # It reached the picker and stopped there until 2026-09-05, so no
        # hire or switch surface could show what the picker already knew.
        "tools": f["tools"],
        # the image-input and reasoning-parameter declarations, same three
        # states, same source, same caveat (unit C, 2026-09-05)
        "image": f["image"],
        "reasoning": f["reasoning"],
    } for f in favorites()]
