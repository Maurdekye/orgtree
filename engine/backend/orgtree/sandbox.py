# pyright: strict
"""Docker sandboxes for kiosk orgs (user spec).

Every kiosk org created with `sandbox: true` runs its agents' turns inside ONE
dedicated container (image: sandbox/Dockerfile) — genuine terminal use with no
view of the host: no host filesystem, no host processes, per-container CPU and
memory caps. Non-kiosk orgs are untouched and run natively.

Container layout (bind mounts):
    /home/agent                          <data>/sandboxes/<slug>/home   (persists
                                         ~/.claude — session transcripts — so
                                         resume-on-demand and read_chat work)
    /home/agent/orgtree/workspaces/<slug>   the org workspace (the ONE window)
    /home/agent/orgtree/scratch/<slug>      node scratch dirs (turn cwds)
    /opt/orgtree-backend                 this backend, read-only (mcptool.py +
                                         steer.py run in-container via python3)

The in-container data layout mirrors the host's ~/orgtree shape on purpose:
steer.py's cwd-derived identity and its ~/orgtree fallback work unchanged.
`.bridge` in the container's data root carries the backend URL
(host.docker.internal:<bridge port>) and, in standard mode, the org's legacy
sandbox secret — the only door out, gated by api.BridgeGateway.

Auth: the default is the PROXIED SUBSCRIPTION — the container's CLI points at
the bridge's /anthropic/<secret> proxy (host-side OAuth, no credential file
ever enters the sandbox). In standard mode, a kiosk `api_key` (creation form /
dashboard) or ORGTREE_SANDBOX_API_KEY overrides it with a plain env key, and
the literal value 'subscription' copies host credentials into the sandbox
home. Frozen mode keeps supported provider keys host-side and routes each org
through a rotatable bridge token; nodes in that shared root-capable container
are mutually trusted at the bridge identity boundary.
"""

from __future__ import annotations

import ipaddress
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from typing import TYPE_CHECKING, Any

from . import bridgeauth, deployment, store

if TYPE_CHECKING:
    from .ledger import Org

_DATA: str = os.path.expanduser(os.environ.get("ORGTREE_DATA", "~/orgtree"))
REPO_ROOT: str = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
BACKEND_DIR: str = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))

IMAGE: str = os.environ.get("ORGTREE_SANDBOX_IMAGE", "orgtree-sandbox")
# bump when sandbox/Dockerfile changes: the tag carries the revision, so
# existing images rebuild and running containers recreate on their next turn
# (r2: passwordless sudo — agents hold root inside the container)
IMG_REV: str = "r2"
BRIDGE_PORT: int = int(os.environ.get("ORGTREE_BRIDGE_PORT", "7362") or 0)
MEM: str = os.environ.get("ORGTREE_SANDBOX_MEM", "4g")
CPUS: str = os.environ.get("ORGTREE_SANDBOX_CPUS", "2")

# Frozen deployments put every agent container on its own Docker-internal
# network.  A tiny, unprivileged relay is the only dual-homed process: it can
# reach the host bridge, but it accepts only the bridge operations frozen mode
# needs (see frozen_gateway.py).  The alias is deliberately identical on every
# per-org network; containers never share a network, so the name resolves only
# to their own relay.
FROZEN_GATEWAY_ALIAS = "orgtree-frozen-gateway"
FROZEN_GATEWAY_PORT = 8765
FROZEN_GATEWAY_LAYOUT = "gateway-v2"
FROZEN_NETWORK_LAYOUT = "frozen-v1"
_frozen_network_lock = threading.Lock()

# --- the one-disk sandbox (user hard requirement 2026-07-31; pivot shipped
# 2026-08-01, D-063: no one in the container may exhaust host disk beyond a
# fixed limit, while container state stays fully editable and survives
# restarts) ------------------------------------------------------------------
# Every sandboxed org's entire mutable state — system dirs, home incl.
# transcripts, workspace, scratch — lives on ONE fixed-size ext4 image,
# loop-mounted by the docker-desktop distro and bind-mounted into the
# container. The FILESYSTEM is the hard cap (ENOSPC); soft tiers in
# supervisor._storage_check_disk pause turns near it; the container is never
# stopped for storage. The rootfs runs READ-ONLY (no unmeasured writable
# surface); /tmp and /run are sized RAM tmpfs, bounded by --memory.
# The pre-disk design (per-org named volumes + reactive daemon-side
# measurement → container stop + freeze) is RETIRED — the SYS_DIRS volume
# names below survive only as migrate_to_disk's source material and the
# per-org rollback the admin sweeps from the settings panel.
SYS_DIRS: tuple[str, ...] = ("usr", "var", "etc", "opt", "root", "srv")
TMP_SIZE: str = os.environ.get("ORGTREE_SANDBOX_TMP", "1g")
RUN_SIZE: str = os.environ.get("ORGTREE_SANDBOX_RUN", "64m")
# default per-org disk limit (MB) for sandboxed orgs whose kiosk/org config
# doesn't set one — 0 disables the default (NOT recommended: unbounded)
DISK_MB: int = int(os.environ.get("ORGTREE_SANDBOX_DISK_MB", "20480") or 0)


def sys_volume(slug: str, d: str) -> str:
    return f"orgtree-sys-{slug}-{d}"


# container layout generation — a label on the container; mismatch = recreate
LAYOUT: str = "disk-v1"


def usrlocal_volume(ver: str) -> str:
    """The version-tagged READ-ONLY /usr/local (user verdict: the CLI stays
    image-pinned even though /usr rides the org disk). Docker seeds it from
    the image on first mount; the version in the name is the №44 invariant —
    a host CLI update moves the name, and the fresh volume seeds from the
    freshly built image."""
    return f"orgtree-usrlocal-{ver}-{IMG_REV}"


def migrate_to_disk(org: Org) -> None:
    """One-time move of a sandboxed org onto its virtual disk (user-approved
    auto-migration): create+mount the disk, copy the org's whole state into
    it — system dirs from its legacy volumes (preserving installs) or the
    image, home/workspace/scratch from the host dirs — verify per-tree file
    counts, then flip the org doc's paths. Old volumes and host dirs are
    KEPT (rollback: clear org.d['disk'] and restart). The calling turn waits;
    a multi-GB org takes minutes, once."""
    from . import disk as dsk
    from .ledger import SYSTEM, now
    slug = org.d["slug"]
    k = org.d.get("kiosk") or {}
    size_mb = (int(k.get("storage_limit_mb") or 0)
               or int((org.d.get("sandbox") or {}).get("limit_mb") or 0)
               or DISK_MB)
    # one-disk semantics: the ~1 GB system seed and transcripts live INSIDE
    # the cap now — a limit written for the old workspace-only accounting
    # (e.g. 256 MB) cannot even hold the seed. Floor it.
    floored_from = 0
    if size_mb < 4096:
        floored_from = size_mb
        print(f"[orgtree] org {slug!r}: configured storage limit {size_mb} MB "
              f"is below the 4096 MB one-disk minimum (the system seed and "
              f"transcripts count now) — using 4096 MB")
        size_mb = 4096
    print(f"[orgtree] migrating org {slug!r} onto its {size_mb} MB disk …")
    dsk.create(slug, size_mb)
    _docker("stop", "-t", "20", container_name(slug), timeout=60)
    image_tag = ensure_image()
    old_home = os.path.join(sandbox_root(slug), "home")
    old_ws = org.d.get("workspace")
    old_scratch = store.scratch_root(slug)
    vols = {d: sys_volume(slug, d)
            for d in ("usr", "var", "etc", "opt", "root", "srv")
            if _docker("volume", "inspect", sys_volume(slug, d)).returncode == 0}
    args: list[str] = ["run", "--rm", "-u", "root",
                       "-v", f"{dsk.mount_path(slug)}:/dst"]
    for d, v in vols.items():
        args += ["-v", f"{v}:/old/{d}:ro"]
    for sub, host in (("home", old_home), ("workspace", old_ws),
                      ("scratch", old_scratch)):
        if host and os.path.isdir(host):
            args += ["-v", f"{host}:/oldhost/{sub}:ro"]
    # system dirs seed from the legacy volume when present, else the image's
    # own rootfs (this helper RUNS that image); host trees copy when present.
    # cp -a preserves modes/links; each tree is count-verified src vs dst.
    script = (
        "set -e; AUID=$(id -u agent); AGID=$(id -g agent); "
        "for d in usr var etc opt root srv; do "
        "  mkdir -p /dst/$d; "
        "  if [ -d /old/$d ]; then S=/old/$d; else S=/$d; fi; "
        "  cp -a $S/. /dst/$d/; "
        "  a=$(find $S -type f | wc -l); b=$(find /dst/$d -type f | wc -l); "
        "  [ \"$a\" = \"$b\" ] || { echo MISMATCH $d $a $b; exit 9; }; "
        "done; "
        "for s in home workspace scratch; do "
        "  mkdir -p /dst/$s; "
        "  if [ -d /oldhost/$s ]; then "
        "    cp -a /oldhost/$s/. /dst/$s/; "
        "    a=$(find /oldhost/$s -type f | wc -l); "
        "    b=$(find /dst/$s -type f | wc -l); "
        "    [ \"$a\" = \"$b\" ] || { echo MISMATCH $s $a $b; exit 9; }; "
        "  fi; "
        "  chown -R $AUID:$AGID /dst/$s; "
        "done; echo MIGRATED")
    r = _docker(*args, image_tag, "sh", "-c", script, timeout=3600)
    if r.returncode != 0 or "MIGRATED" not in (r.stdout or ""):
        raise RuntimeError(f"org {slug!r} disk migration failed — nothing "
                           f"was flipped; old state is untouched: "
                           + (r.stderr or r.stdout)[-500:])
    new_ws = dsk.windows_sub(slug, "workspace")
    with store.DOC_LOCK:
        o2 = store.load_org(slug)
        o2.d["disk"] = {"size_mb": size_mb, "migrated_at": now()}
        # the legacy enforcement is RETIRED (user ruling 2026-08-01, D-063):
        # clear any pre-migration storage freeze the doc still carries —
        # nothing sets or clears that flag anymore, so it would stick forever
        o2.d.pop("storage_frozen", None)
        for n in o2.nodes.values():
            fz = n.get("frozen")
            if isinstance(fz, dict) and fz.pop("storage", None):
                fz.pop("storage_error", None)
                if not fz.get("resume_texts") and not fz.get("error") \
                        and not fz.get("until"):
                    n.pop("frozen", None)
        if old_ws:
            for dd in o2.d["dirs"]:
                if os.path.normpath(dd["path"]) == os.path.normpath(old_ws):
                    dd["path"] = new_ws
            for n in o2.nodes.values():
                for dd in n["scope"]["add_dirs"]:
                    if os.path.normpath(dd["path"]) == os.path.normpath(old_ws):
                        dd["path"] = new_ws
        o2.d["workspace"] = new_ws
        if floored_from:
            # review 2026-08-01: flooring RAISES a cap the operator
            # deliberately set — that change belongs in their inbox, not
            # only the backend log
            from . import events as _events
            dev = _events.mint("lifecycle.disk_migrated", {"kind": "system", "id": SYSTEM},
                               o2.org_ref(), floored_from=str(floored_from))
            o2.to_user_inbox({
                "id": uuid.uuid4().hex[:12], "from": SYSTEM, "kind": "notice",
                "at": now(), "body": _events.render_agent(dev)}, dev)
        store.save_org(o2)
    _disk_flag.pop(slug, None)
    print(f"[orgtree] org {slug!r} migrated to its disk "
          f"({size_mb} MB; legacy volumes kept for rollback)")


_vm_cap_cache: tuple[float, int | None] | None = None


def vm_disk_cap_mib() -> int | None:
    """Docker Desktop's VM disk cap in MiB, or None when unset — the ABSOLUTE
    host bound on every container, image, and (sparse) org disk, no matter
    what this code does. A host setting we can only read; best-effort, the
    settings file location/keys are Docker Desktop internals. Surfaced
    IN-PRODUCT by the recovery browser (review suggestion 2026-08-01: the
    admin staring at storage is the right audience, not the backend log)."""
    global _vm_cap_cache
    if _vm_cap_cache and time.time() - _vm_cap_cache[0] < 300:
        return _vm_cap_cache[1]
    cap: int | None = None
    if os.name == "nt":
        try:
            p = os.path.join(os.environ.get("APPDATA", ""), "Docker",
                             "settings-store.json")
            cfg: dict[str, Any] = (json.load(open(p, encoding="utf-8"))
                                   if os.path.exists(p) else {})
            raw = next((v for k, v in cfg.items()
                        if k.lower() == "disksizemib"), None)
            cap = int(raw) if raw else None
        except Exception:                                # noqa: BLE001
            cap = None
    _vm_cap_cache = (time.time(), cap)
    return cap


_vm_cap_warned = False


def _warn_vm_cap() -> None:
    """One startup log line (the browser carries the in-product version)."""
    global _vm_cap_warned
    if _vm_cap_warned or os.name != "nt":
        return
    _vm_cap_warned = True
    cap = vm_disk_cap_mib()
    if cap:
        print(f"[orgtree] Docker VM disk cap: {cap} MiB "
              f"(the absolute sandbox storage backstop)")
    else:
        print("[orgtree] ⚠ Docker Desktop's disk image size is UNSET "
              "(defaults to a ~1 TB sparse disk) — the recovery browser "
              "shows this to the admin; set it in Docker Desktop → "
              "Settings → Resources.")

_build_lock: threading.Lock = threading.Lock()


def _cfg(org: Org) -> dict[str, str] | None:
    """Sandbox config for ANY org (user ruling: not just kiosks): kiosks
    carry it inside their kiosk dict; normal orgs in a top-level `sandbox`."""
    k = org.d.get("kiosk") or {}
    if k.get("sandbox"):
        return {"secret": k.get("sandbox_secret", "")}
    s = org.d.get("sandbox") or {}
    if s.get("enabled"):
        return {"secret": s.get("secret", "")}
    return None


def is_sandboxed(org: Org) -> bool:
    return _cfg(org) is not None


_docker_ok: bool | None = None


def docker_available() -> bool:
    """Is a docker CLI on PATH? (cached — the UI disables the sandbox
    checkbox entirely when it isn't; user ruling)"""
    global _docker_ok
    if _docker_ok is None:
        _docker_ok = shutil.which("docker") is not None
    return _docker_ok


def sandbox_secret(org: Org) -> str:
    """The persisted org-wide bridge root (legacy compatibility only)."""
    return bridgeauth.root_secret(org)


def bridge_credential(org: Org) -> str:
    """The rotatable per-org credential used under the live policy."""
    return bridgeauth.credential_for_org(org)


def legacy_bridge_credentials_allowed() -> bool:
    """Whether shared org-wide bridge credentials remain policy-allowed."""
    return bridgeauth.legacy_credentials_allowed()


def uses_subscription_auth(k: dict[str, Any] | None) -> bool:
    """True when the org's sandbox would run on COPIED host credentials
    (the 'subscription' escape hatch — docstring: private single-user
    installs only). Security review 2026-08-01: this mode and a PUBLIC
    kiosk URL are mutually exclusive STRUCTURALLY — the OAuth token lands
    on the org disk, root-in-container can copy it to any path, and the
    recovery browser serves the disk to visitors; no filename denylist can
    be a boundary. Both enable-orderings are refused."""
    key = ((k or {}).get("api_key")
           or os.environ.get("ORGTREE_SANDBOX_API_KEY") or "proxied")
    return str(key).strip().lower() == "subscription"


def _configured_container_auth(org: Org, k: Any = None) -> str:
    """Resolve sandbox auth without applying deployment-policy gates."""
    k = (org.d.get("kiosk") or {}) if k is None else k
    return (("" if org.d.get("api_fallback")
             else str(org.d.get("api_key") or ""))
            or str(k.get("api_key") or "")
            or os.environ.get("ORGTREE_SANDBOX_API_KEY")
            or "proxied").strip()


def uses_legacy_credential_copy(org: Org, k: Any = None) -> bool:
    """Whether the effective selector asks to copy host credentials."""
    return _configured_container_auth(org, k).lower() == "subscription"


def _legacy_selector_present(org: Org, k: Any = None) -> bool:
    """Whether any selectable auth source contains the forbidden sentinel."""
    k = (org.d.get("kiosk") or {}) if k is None else k
    return any(str(value or "").strip().lower() == "subscription"
               for value in (org.d.get("api_key"), k.get("api_key"),
                             os.environ.get("ORGTREE_SANDBOX_API_KEY")))


def copied_subscription_credentials(org: Org) -> bool:
    """Whether a previous standard-mode run left host credentials on disk.

    A permission or filesystem error is not evidence that the credential is
    absent. Frozen mode treats an unverifiable path as a configuration error.
    """
    path = "<sandbox credential path>"
    try:
        path = os.path.join(sandbox_home(org.d["slug"]), ".claude",
                            ".credentials.json")
        os.lstat(path)
    except FileNotFoundError:
        return False
    except (KeyError, OSError, RuntimeError, TypeError) as e:
        raise deployment.DeploymentConfigError(
            "could not verify that the sandbox is free of copied subscription "
            f"credentials ({path}: {e})") from e
    return True


def container_name(slug: str) -> str:
    return "orgtree-" + slug


def frozen_network_name(slug: str) -> str:
    return "orgtree-frozen-" + slug


def frozen_gateway_name(slug: str) -> str:
    return "orgtree-frozen-gateway-" + slug


def sandbox_root(slug: str) -> str:
    return os.path.join(_DATA, "sandboxes", slug)


# virtual-disk pivot (user verdict 2026-07-31): a migrated org's state lives
# ON its disk; host-side readers must follow it there. The flag is on the org
# doc — cached briefly so hot paths (usage walks, transcript reads) don't
# re-load the doc per call.
_disk_flag: dict[str, tuple[float, bool]] = {}


def on_disk(slug: str) -> bool:
    hit = _disk_flag.get(slug)
    if hit and time.time() - hit[0] < 10:
        return hit[1]
    try:
        val = bool(store.load_org(slug).d.get("disk"))
    except Exception:                                    # noqa: BLE001
        val = False
    _disk_flag[slug] = (time.time(), val)
    return val


def auth_label(org: Org, k: Any = None) -> str:
    """The container's auth as an identity token: `proxied`, `subscription`,
    or `key:<8 hex>` — a digest, never the key itself (labels are readable by
    anyone who can run `docker inspect`). Compared on every `ensure_container`
    so a settings change, a key rotation or an unset `ORGTREE_SANDBOX_API_KEY`
    recreates the container instead of leaving it billing the old way."""
    import hashlib
    auth = container_auth(org, k)
    # Frozen containers inherit no provider auth material, so their identity
    # does not depend on which host-side provider lane is selected. This fixed label
    # forces one recreate at either profile boundary but lets explicit keys
    # rotate live without exposing even a key digest or recreating the box.
    if not bridgeauth.legacy_credentials_allowed():
        return "org-v1"
    low = auth.lower()
    if "prox" in low or low == "subscription":
        return low
    return "key:" + hashlib.sha256(auth.encode()).hexdigest()[:8]


def container_auth(org: Org, k: Any = None) -> str:
    """What a sandboxed org's container authenticates WITH: a literal API key,
    `"subscription"` (host credentials copied in), or `"proxied"` (the bridge
    attaches the host token per request).

    Factored out of `ensure_container` (redteam 2026-08-18) because a second
    caller needs the same answer and a hand-mirrored copy would drift:
    `supervisor.bills_the_key` has to know whether a limit error came off the
    org's own key or the host subscription, and reading `org.d["api_key"]`
    alone missed BOTH the kiosk-level key and `ORGTREE_SANDBOX_API_KEY` — a
    per-minute API rate limit was then timed off the subscription's lanes."""
    auth = _configured_container_auth(org, k)
    if not deployment.current_policy().allow_legacy_sandbox_credentials:
        if _legacy_selector_present(org, k):
            raise deployment.DeploymentConfigError(
                "the frozen deployment profile disables legacy sandbox "
                "credential copying; 'subscription' auth is forbidden -- use "
                "proxied auth or an explicit API key")
        if copied_subscription_credentials(org):
            raise deployment.DeploymentConfigError(
                "the frozen deployment profile refuses this sandbox because "
                "copied subscription credentials already exist on its disk; "
                "remove the sandbox credential copy before running it")
    return auth


def shared_container_auth_env(org: Org, k: Any = None) -> dict[str, str]:
    """Auth env baked into the shared container at ``docker run``.

    Frozen mode returns nothing for every supported provider auth selection:
    its provider URL and per-org bridge token are attached later by
    ``docker exec``, and an explicit provider key stays on the host. The
    ``container_auth`` call is deliberately before the policy branch so its
    fail-closed validation cannot be bypassed by this helper.
    """
    key = container_auth(org, k)
    if not legacy_bridge_credentials_allowed():
        return {}
    low = key.lower()
    if "prox" in low:
        return {
            "ANTHROPIC_BASE_URL": f"{bridge_url()}/anthropic/{sandbox_secret(org)}",
            "ANTHROPIC_API_KEY": "orgtree-proxied",
        }
    if low == "subscription":
        return {}
    return {"ANTHROPIC_API_KEY": key}


def anthropic_proxy_api_key(org: Org, *, fallback_active: bool = False) -> str:
    """Explicit key the host-side Anthropic relay should attach.

    Standard mode keeps its historical split: literal keys live directly in
    the container, while only api-fallback temporarily switches relay traffic
    to the org key. Frozen mode routes literal keys through the per-org relay
    too, so the actual provider credential never enters the shared container.
    An empty return means the relay should use the host OAuth subscription.

    Always resolve ``container_auth`` first.  Besides choosing org, kiosk, and
    install-default keys consistently, it owns frozen policy validation of
    forbidden legacy selectors.
    """
    selected = container_auth(org)
    if fallback_active:
        return str(org.d.get("api_key") or "").strip()
    if legacy_bridge_credentials_allowed():
        return ""
    low = selected.lower()
    if "prox" in low or low == "subscription":
        return ""
    return selected


def sandbox_home(slug: str) -> str:
    if on_disk(slug):
        from . import disk
        return disk.windows_sub(slug, "home")
    return os.path.join(sandbox_root(slug), "home")


# in-container paths (the mirror of the host layout)
def cpath_data() -> str:
    return "/home/agent/orgtree"


def cpath_workspace(slug: str) -> str:
    return f"{cpath_data()}/workspaces/{slug}"


def cpath_scratch(slug: str, nid: str) -> str:
    return f"{cpath_data()}/scratch/{slug}/{nid.split('@')[0]}"


def bridge_url() -> str:
    """The bridge address visible inside an agent container.

    Standard deployments keep the historical direct host-gateway route.
    Frozen containers have no external route at all; the stable hostname is
    their private network's fixed-upstream relay instead.
    """
    if not deployment.current_policy().allow_sandbox_internet:
        validate_deployment_network()
        return f"http://{FROZEN_GATEWAY_ALIAS}:{FROZEN_GATEWAY_PORT}"
    return f"http://host.docker.internal:{BRIDGE_PORT}"


def validate_deployment_network(
        *, policy: deployment.DeploymentPolicy | None = None) -> None:
    """Refuse a frozen profile that has no usable host bridge listener."""
    selected = policy or deployment.current_policy()
    if selected.allow_sandbox_internet:
        return
    if not 1 <= BRIDGE_PORT <= 65535:
        raise deployment.DeploymentConfigError(
            "the frozen deployment profile requires ORGTREE_BRIDGE_PORT to "
            "be an enabled TCP port from 1 through 65535; the private "
            "sandbox gateway is the only permitted service path")


def bridge_bind_host() -> str:
    """Return the host-only address for the backend bridge listener.

    Docker Desktop forwards ``host.docker.internal`` to loopback services on
    Windows and macOS.  Native Linux uses the default bridge's host-side
    gateway address instead: it is reachable by the relay container but is
    not a LAN bind.  Refuse startup if that address cannot be established;
    falling back to 0.0.0.0 would silently undo the frozen boundary.
    """
    if deployment.current_policy().allow_sandbox_internet:
        return "0.0.0.0"
    validate_deployment_network()
    if sys.platform in ("win32", "darwin"):
        return "127.0.0.1"
    try:
        r = _docker("network", "inspect", "bridge", "--format",
                    "{{(index .IPAM.Config 0).Gateway}}")
    except (OSError, subprocess.TimeoutExpired) as e:
        raise RuntimeError("frozen deployment cannot inspect Docker's host "
                           f"bridge address: {e}") from e
    raw = r.stdout.strip()
    try:
        addr = ipaddress.ip_address(raw)
    except ValueError as e:
        detail = (r.stderr or raw or "no address returned").strip()
        raise RuntimeError("frozen deployment cannot determine Docker's "
                           f"host-only bridge address: {detail}") from e
    if addr.is_unspecified or addr.is_loopback or addr.is_multicast:
        raise RuntimeError("frozen deployment got an unusable Docker bridge "
                           f"address: {addr}")
    return str(addr)


def bridge_file_config(org: Org) -> dict[str, str]:
    """Shared ``.bridge`` content; frozen mode contains no credential."""
    out = {"url": bridge_url()}
    if legacy_bridge_credentials_allowed():
        out["secret"] = sandbox_secret(org)
    return out


def chown_agent(org: Org, nid: str, *rel: str) -> None:
    """Hand a backend-minted path inside a sandboxed org to the agent.

    The backend writes through the \\\\wsl.localhost UNC view, and everything
    it creates lands root-owned inside the container — while the CLI runs as
    `agent` (uid 1001). A root-owned `outbox/` or `uploads/` reads to the
    agent as "my scratch is broken" (live bug 2026-08-04, kiosk `vnuser`).
    Best-effort by design: with the container down the exec fails silently,
    and the start-time heal in ensure_container covers it instead."""
    if not is_sandboxed(org):
        return
    slug = org.d["slug"]
    target = "/".join((cpath_scratch(slug, nid), *rel))
    try:
        # ⚠ -u root: exec inherits the image's USER agent, and an unprivileged
        # chown fails "Operation not permitted" — silently, given the swallow
        # below (caught live 2026-08-05 healing vnuser by hand)
        _docker("exec", "-u", "root", container_name(slug),
                "chown", "-R", "agent:agent", target, timeout=30)
    except Exception:                                        # noqa: BLE001
        pass


def chown_home_path(org: Org, host_path: str) -> None:
    """`chown_agent` for a path under the container HOME rather than the data
    root — the transcript store (`/home/agent/.claude/projects/…`) is the case
    that needed it (2026-08-20).

    `chown_agent` only builds paths under `cpath_scratch`, and `_heal_ownership`
    only sweeps `cpath_data()` = /home/agent/orgtree, so nothing covered
    ~/.claude at all. A session file the backend mints there — the cut that
    turns a CLI-compacted generation into a consultable bearer — lands
    root-owned, and the agent that rehires it can read but not append, so the
    bearer fails on the first write of its resumed turn.

    Best-effort on the same terms as chown_agent: a host path outside this
    org's sandbox home, or a container that is down, is a silent no-op."""
    if not is_sandboxed(org):
        return
    slug = org.d["slug"]
    try:
        rel = os.path.relpath(host_path, sandbox_home(slug))
    except ValueError:              # different drive — not ours to touch
        return
    if rel.startswith(".."):        # outside the container home
        return
    target = "/home/agent/" + rel.replace("\\", "/")
    try:
        _docker("exec", "-u", "root", container_name(slug),
                "chown", "agent:agent", target, timeout=30)
    except Exception:                                        # noqa: BLE001
        pass


def _heal_ownership(name: str) -> None:
    """Every path the backend minted while the container was DOWN is
    root-owned (see chown_agent) — hand the whole data tree back to the agent
    at container start. Also fixes Docker's own root-owned mount scaffolding
    (/home/agent/orgtree, …/scratch, …/workspaces), which the agent sees when
    it looks one level above its own folder."""
    _docker("exec", "-u", "root", name, "chown", "-R", "agent:agent",
            cpath_data(), timeout=120)


def _docker(*args: str, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True,
                          timeout=timeout,
                          creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                                         if os.name == "nt" else 0))


def docker_ok() -> bool:
    try:
        return _docker("version", "--format", "{{.Server.Version}}").returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def _desired_image_tag(
        policy: deployment.DeploymentPolicy | None = None) -> str:
    """Return the policy-selected image tag without building or pulling it."""

    selected = policy or deployment.current_policy()
    if selected.name == "frozen":
        from . import frozen_install
        return frozen_install.required_sandbox_image_tag()
    from . import supervisor        # lazy — supervisor imports this module
    ver = supervisor.cli_version()
    return f"{IMAGE}:{ver}-{IMG_REV}" if ver != "unknown" else IMAGE


def _usrlocal_key(policy: deployment.DeploymentPolicy | None = None) -> str:
    """What the read-only /usr/local volume's name is keyed to.

    Docker seeds that volume from the image ONCE, on first mount, and the
    name is the only thing deciding whether an existing volume is reused. In
    standard mode the host CLI version is the right key (№44: a CLI update
    moves the name, so the fresh volume seeds from the freshly built image).

    ⚠ In frozen mode it must key to the APPROVED CONFIGURATION instead. A
    frozen image and a standard image can be built at the same host CLI
    version, so sharing that key would let a frozen container mount a
    /usr/local seeded from an unapproved standard image — the pins would
    still verify while the CLI actually executing came from somewhere else.
    """

    selected = policy or deployment.current_policy()
    if selected.name == "frozen":
        from . import frozen_install
        # Exactly the content-addressed suffix the approved image tag
        # carries, so image and volume move together by construction.
        tag = frozen_install.required_sandbox_image_tag()
        return tag.rsplit(":", 1)[-1]
    from . import supervisor        # lazy — supervisor imports this module
    return supervisor.cli_version()


def ensure_image() -> str:
    """№44 (user-approved): the image is TAGGED with the host CLI's version
    and pins the same version inside — when the host CLI updates, the next
    sandboxed turn rebuilds instead of running a CLI frozen at first-build.
    Returns the tag to run."""
    policy = deployment.current_policy()
    if policy.name == "frozen":
        # Frozen startup has already checked this image, but enforce the same
        # immutable tag/labels again at the exact runtime boundary. Never turn
        # a missing approved artifact into a mutable network build.
        from . import frozen_install
        return frozen_install.require_approved_sandbox_image()

    from . import supervisor        # lazy — supervisor imports this module
    ver = supervisor.cli_version()
    tag = _desired_image_tag(policy)
    if _docker("image", "inspect", tag).returncode == 0:
        return tag
    with _build_lock:
        if _docker("image", "inspect", tag).returncode == 0:
            return tag
        args = ["build", "-t", tag]
        if ver != "unknown":
            args += ["--build-arg", f"CLAUDE_VERSION={ver}"]
        r = _docker(*args, os.path.join(REPO_ROOT, "sandbox"), timeout=1200)
        if r.returncode != 0:
            raise RuntimeError("sandbox image build failed: "
                               + (r.stderr or r.stdout)[-500:])
    return tag


def _ensure_frozen_gateway(slug: str, image_tag: str) -> None:
    """Create the per-org internal network and its fixed-upstream relay.

    Only the relay is dual-homed.  The agent container joins the ``--internal``
    network below and therefore has no route to the host, LAN, or internet.
    The relay has no writable state, no capabilities, no published port, and
    runs only frozen_gateway.py from the backend's read-only bind.
    """
    validate_deployment_network()
    net = frozen_network_name(slug)
    name = frozen_gateway_name(slug)
    with _frozen_network_lock:
        net_fmt = '{{.Internal}} {{index .Labels "orgtree.frozen"}}'
        net_ins = _docker("network", "inspect", net, "--format", net_fmt)
        if net_ins.returncode != 0:
            made = _docker("network", "create", "--driver", "bridge",
                           "--internal", "--label", "orgtree.frozen=1", net)
            if made.returncode != 0 \
                    and _docker("network", "inspect", net).returncode != 0:
                raise RuntimeError("frozen sandbox network creation failed: "
                                   + (made.stderr or made.stdout)[-500:])
            net_ins = _docker("network", "inspect", net, "--format", net_fmt)
        if net_ins.returncode != 0 \
                or net_ins.stdout.strip().split() != ["true", "1"]:
            raise RuntimeError(
                f"refusing existing Docker network {net!r}: frozen mode "
                "requires an internal network carrying orgtree.frozen=1")

        ins = _docker(
            "container", "inspect", "-f",
            "{{.State.Running}} {{.Config.Image}} "
            '{{index .Config.Labels "orgtree.layout"}}', name)
        valid = False
        running = False
        if ins.returncode == 0:
            parts = ins.stdout.split()
            running = bool(parts and parts[0] == "true")
            valid = (len(parts) >= 3 and parts[1] == image_tag
                     and parts[2] == FROZEN_GATEWAY_LAYOUT)
            if not valid:
                _docker("rm", "-f", name, timeout=60)
        if not valid:
            # ⚠ A LITERAL POSIX PATH, never os.path.join. This names a file
            # inside a LINUX container, and os.path.join uses the HOST's
            # separator: on Windows it produced
            # "/opt/orgtree-backend\\orgtree\\frozen_gateway.py" and the relay
            # died on every start with "can't open file". The frozen network
            # boundary therefore never came up on Windows at all — the fake
            # Docker in the tests only ever compared argv strings, so nothing
            # noticed that the path could not resolve.
            relay = "/opt/orgtree-backend/orgtree/frozen_gateway.py"
            run = _docker(
                "create", "--name", name,
                "--label", f"orgtree.layout={FROZEN_GATEWAY_LAYOUT}",
                "--label", f"orgtree.frozen.slug={slug}",
                "--read-only", "--tmpfs", "/tmp:rw,size=16m,mode=1777",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "--memory", "128m", "--cpus", "0.25", "--pids-limit", "64",
                "--network", "bridge",
                "--add-host", "host.docker.internal:host-gateway",
                "-e", "PYTHONDONTWRITEBYTECODE=1",
                "-v", f"{BACKEND_DIR}:/opt/orgtree-backend:ro",
                image_tag, "python3", "-B", relay,
                "--upstream", f"http://host.docker.internal:{BRIDGE_PORT}",
                "--bind", FROZEN_GATEWAY_ALIAS,
                "--port", str(FROZEN_GATEWAY_PORT), timeout=120)
            if run.returncode != 0:
                raise RuntimeError("frozen sandbox gateway creation failed: "
                                   + (run.stderr or run.stdout)[-500:])

        nets = _docker("container", "inspect", "-f",
                       "{{json .NetworkSettings.Networks}}", name)
        try:
            attachments = set(json.loads(nets.stdout))
        except (json.JSONDecodeError, TypeError):
            raise RuntimeError("cannot verify frozen sandbox gateway network: "
                               + (nets.stderr or nets.stdout)[-500:])
        if "bridge" not in attachments or attachments - {"bridge", net}:
            raise RuntimeError("refusing frozen sandbox gateway with unexpected "
                               f"network attachments: {sorted(attachments)}")
        attached = net in attachments
        if not attached:
            joined = _docker("network", "connect", "--alias",
                             FROZEN_GATEWAY_ALIAS, net, name)
            if joined.returncode != 0:
                raise RuntimeError("cannot attach frozen sandbox gateway to "
                                   "its private network: "
                                   + (joined.stderr or joined.stdout)[-500:])
        # Attach the private network before first start.  frozen_gateway binds
        # only its alias on that interface, so its HTTP listener is not
        # reachable from unrelated containers on the ordinary bridge.
        if not running:
            started = _docker("start", name)
            if started.returncode != 0:
                raise RuntimeError("frozen sandbox gateway failed to start: "
                                   + (started.stderr or started.stdout)[-500:])
        elif not attached:
            # A running relay which lost and regained the private endpoint is
            # still bound to the old address.  Restart it after reconnecting.
            stopped = _docker("stop", "-t", "2", name)
            started = _docker("start", name) if stopped.returncode == 0 \
                else stopped
            if started.returncode != 0:
                raise RuntimeError("frozen sandbox gateway failed to restart "
                                   "after network repair: "
                                   + (started.stderr or started.stdout)[-500:])


def _remove_frozen_gateway(slug: str) -> None:
    """Best-effort cleanup after the agent container has been removed."""
    try:
        _docker("rm", "-f", frozen_gateway_name(slug), timeout=60)
        _docker("network", "rm", frozen_network_name(slug), timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        pass


def ensure_container(org: Org) -> str:
    """The org's container, created on first need and restarted if stopped.
    Raises RuntimeError with an actionable message when it cannot run."""
    slug = org.d["slug"]
    k = org.d.get("kiosk") or {}
    name = container_name(slug)
    policy = deployment.current_policy()
    network_layout = ("standard" if policy.allow_sandbox_internet
                      else FROZEN_NETWORK_LAYOUT)
    if not docker_ok():
        raise RuntimeError("Docker is not running — start Docker Desktop "
                           "(kiosk sandboxes run their turns in containers)")
    _warn_vm_cap()
    from . import disk as dsk
    # virtual-disk pivot (user verdict): every sandboxed org rides its own
    # capped ext4 disk. Legacy (volume-layout) orgs migrate on first need —
    # user-approved auto-migration; old volumes are KEPT for rollback.
    if not org.d.get("disk"):
        migrate_to_disk(org)
        org = store.load_org(slug)        # workspace/dirs were rewritten
    ins0 = _docker("container", "inspect", "-f", "{{.State.Running}}", name)
    if ins0.returncode != 0 or ins0.stdout.strip() != "true":
        # a natural container-down moment — the RULED trigger for a pending
        # shrink (it needs THIS org's container down, never the backend).
        # Best-effort: a refusal keeps the request pending, logged; the UI's
        # divergence chip keeps showing intent vs reality.
        try:
            note = try_apply_pending_resize(org)
            if note:
                print(f"[orgtree] org {slug!r}: {note}")
        except Exception as e:                          # noqa: BLE001
            print(f"[orgtree] org {slug!r}: pending-shrink attempt failed: {e}")
    # ⚠ mount-verify before EVERY start: /mnt/wsl dies with the WSL VM and
    # Docker mints an EMPTY DIR for a missing bind source — an org must
    # hard-refuse to run rather than bind an empty workspace and diverge.
    dsk.mount(slug)                        # sentinel-verified; raises DiskError
    want = _desired_image_tag(policy)
    usrlocal = _usrlocal_key(policy)
    ins = _docker("container", "inspect", "-f",
                  "{{.State.Running}} {{.Config.Image}} "
                  '{{index .Config.Labels "orgtree.layout"}} '
                  '{{index .Config.Labels "orgtree.auth"}} '
                  '{{index .Config.Labels "orgtree.network"}}', name)
    if ins.returncode == 0:
        parts = ins.stdout.split()
        running = parts[0] if parts else ""
        cur_img = parts[1] if len(parts) > 1 else ""
        layout = parts[2] if len(parts) > 2 else ""
        cur_auth = parts[3] if len(parts) > 3 else ""
        cur_network = parts[4] if len(parts) > 4 else ""
        # Containers created before this profile existed are ordinary Docker
        # bridge containers.  Treat the missing label as standard so merely
        # upgrading a normal install does not recreate them.
        if cur_network in ("", "<no value>"):
            cur_network = "standard"
        # №44: the CLI rides the version-tagged read-only /usr/local volume,
        # so an image move requires a recreate (which re-mounts that volume);
        # a pre-disk layout recreates too (its state already migrated).
        # AUTH likewise (redteam 2026-08-18): `docker run -e
        # ANTHROPIC_API_KEY=…` bakes the credential in, so a container created
        # under one auth kept billing that way after the org's settings moved
        # — and `supervisor.bills_the_key`, which reads the CONFIG, then timed
        # the container's own API limits against the host subscription's
        # lanes. Recreating on change is what makes the config truthful.
        if (cur_img and cur_img != want) or layout != LAYOUT \
                or cur_auth != auth_label(org, k) \
                or cur_network != network_layout:
            _docker("rm", "-f", name, timeout=60)
            if cur_network == FROZEN_NETWORK_LAYOUT \
                    and network_layout == "standard":
                _remove_frozen_gateway(slug)
        else:
            if network_layout == FROZEN_NETWORK_LAYOUT:
                _ensure_frozen_gateway(slug, want)
            if running != "true":
                _docker("start", name)
                _heal_ownership(name)
            return name
    # auth (user ruling): PROXIED SUBSCRIPTION is the default for every kiosk
    # — the container's CLI talks to the bridge's /anthropic passthrough and
    # the HOST attaches the OAuth token; no credential ever enters the
    # sandbox. ORGTREE_SANDBOX_API_KEY remains a hidden escape hatch (a real
    # API key, or 'subscription' to copy the host credentials in).
    # §9.5: the ORG-LEVEL key (settings, any org — promoted out of the kiosk
    # spec) outranks the kiosk field; proxy mode and key mode stay mutually
    # exclusive — a set key wins and the bridge proxy is not used.
    # api_fallback (2026-08-17): a fallback org must stay PROXIED — container
    # env is fixed at `docker run`, so the per-request auth flip lives in the
    # bridge's /anthropic passthrough instead; skipping the org key here is
    # what routes it there
    key = container_auth(org, k)
    use_sub = key.lower() == "subscription"
    if use_sub and k.get("enabled") and k.get("token"):
        # structural, not a filter: see uses_subscription_auth
        raise RuntimeError(
            "subscription-auth sandbox with a PUBLIC kiosk URL is refused — "
            "the copied host credentials live on the org disk visitors can "
            "browse. Disable the kiosk URL or switch to proxied auth.")
    image_tag = ensure_image()
    home = sandbox_home(slug)              # on-disk, via the UNC view
    os.makedirs(os.path.join(home, "orgtree"), exist_ok=True)
    if use_sub:
        os.makedirs(os.path.join(home, ".claude"), exist_ok=True)
        src = os.path.expanduser("~/.claude/.credentials.json")
        if not os.path.isfile(src):
            raise RuntimeError("subscription mode: no Claude credentials found "
                               "at ~/.claude/.credentials.json")
        import shutil as _sh
        _sh.copy2(src, os.path.join(home, ".claude", ".credentials.json"))
        cfg = os.path.join(home, ".claude.json")
        if not os.path.exists(cfg):
            with open(cfg, "w", encoding="utf-8") as f:
                json.dump({"hasCompletedOnboarding": True}, f)
    # The locator is shared because the container is shared. Frozen mode keeps
    # its rotatable per-org bearer out of the persistent file and injects it
    # into each process/hook. This is at-rest reduction, not node isolation:
    # root-capable siblings can read each other's live process state. Standard
    # mode keeps the old document shape as its migration path.
    bridge_doc = bridge_file_config(org)
    with open(os.path.join(home, "orgtree", ".bridge"), "w",
              encoding="utf-8") as f:
        json.dump(bridge_doc, f)
    mp = dsk.mount_path(slug)
    if network_layout == FROZEN_NETWORK_LAYOUT:
        _ensure_frozen_gateway(slug, image_tag)
    r = _docker(
        "run", "-d", "--name", name,
        "--label", f"orgtree.layout={LAYOUT}",
        "--label", f"orgtree.auth={auth_label(org, k)}",
        "--label", f"orgtree.network={network_layout}",
        "--memory", MEM, "--cpus", CPUS,
        # ONE capped disk (user verdict): rootfs read-only, every persistent
        # write — system dirs, home incl. transcripts, workspace, scratch —
        # lands on the org's ext4 image; ENOSPC is the enforcement. /tmp and
        # /run are RAM, bounded by --memory. /usr/local is the version-tagged
        # READ-ONLY volume: the CLI stays image-pinned under the /usr shadow.
        "--read-only",
        "--tmpfs", f"/tmp:rw,size={TMP_SIZE},mode=1777",
        "--tmpfs", f"/run:rw,size={RUN_SIZE}",
        *(["--network", frozen_network_name(slug)]
          if network_layout == FROZEN_NETWORK_LAYOUT else []),
        *[a for d in SYS_DIRS for a in ("-v", f"{mp}/{d}:/{d}")],
        "-v", f"{usrlocal_volume(usrlocal)}:/usr/local:ro",
        *([] if network_layout == FROZEN_NETWORK_LAYOUT else
          ["--add-host", "host.docker.internal:host-gateway"]),
        *[item for env_key, env_val in
          sorted(shared_container_auth_env(org, k).items())
          for item in ("-e", f"{env_key}={env_val}")],
        "-v", f"{mp}/home:/home/agent",
        "-v", f"{mp}/workspace:{cpath_workspace(slug)}",
        "-v", f"{mp}/scratch:{cpath_data()}/scratch/{slug}",
        "-v", f"{BACKEND_DIR}:/opt/orgtree-backend:ro",
        image_tag, "sleep", "infinity", timeout=300)
    if r.returncode != 0:
        if network_layout == FROZEN_NETWORK_LAYOUT:
            _remove_frozen_gateway(slug)
        raise RuntimeError("sandbox container failed to start: "
                           + (r.stderr or r.stdout)[-500:])
    _heal_ownership(name)
    return name


def try_apply_pending_resize(org: Org) -> str | None:
    """Apply a doc-persisted pending shrink (user design: record the request,
    apply when the org's container is down anyway, show the divergence until
    then). CALLER guarantees the container is down. Returns None when there
    was nothing pending or it applied; a human-readable reason when the
    shrink was KEPT PENDING (refuse-not-guess: usage may have outgrown the
    target while it waited — never partially apply, say how many MB to free)."""
    from . import disk as dsk
    slug = org.d["slug"]
    d = dict(org.d.get("disk") or {})
    pend = int(d.get("pending_size_mb") or 0)
    if not pend:
        return None
    dsk.mount(slug)                      # need a fresh usage reading
    du = dsk.usage(slug, max_age=0.0)
    # ~90% fit: resize2fs needs working room, and landing at 100% would be
    # an instant hard-full
    if du and du[0] > pend * 1048576 * 0.9:
        need = int((du[0] - pend * 1048576 * 0.9) / 1048576) + 1
        return (f"pending shrink to {pend} MB not applied: usage is "
                f"{du[0] // 1048576} MB — free about {need} MB first")
    dsk.shrink_image(slug, pend)
    dsk.mount(slug)
    with store.DOC_LOCK:
        o2 = store.load_org(slug)
        d2 = dict(o2.d.get("disk") or {})
        d2["size_mb"] = pend
        d2.pop("pending_size_mb", None)
        o2.d["disk"] = d2
        store.save_org(o2)
    print(f"[orgtree] org {slug!r}: pending shrink applied — disk is now "
          f"{pend} MB")
    return None


def stop_container(slug: str) -> None:
    """Storage-breach lever: halt the org's container so volume growth stops.
    20 s grace lets the CLI flush transcript appends (they live on the home
    bind, which stays writable — engine state is never starved by the cap)."""
    try:
        _docker("stop", "-t", "20", container_name(slug), timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        pass


_vol_usage_cache: dict[str, tuple[float, int]] = {}


def _parse_size(s: str) -> int:
    """Docker's human sizes ("5.34MB", "1.06GB", "0B") — SI decimal units."""
    s = (s or "").strip()
    units = {"B": 1, "KB": 10**3, "MB": 10**6, "GB": 10**9, "TB": 10**12}
    for u, mul in sorted(units.items(), key=lambda kv: -len(kv[0])):
        if s.upper().endswith(u):
            try:
                return int(float(s[:-len(u)]) * mul)
            except ValueError:
                return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def sandbox_volumes_bytes(slug: str, max_age: float = 60.0) -> int | None:
    """Bytes in the org's system volumes, measured DAEMON-SIDE (`docker system
    df -v`), so it works with the container stopped — the auto-unblock path
    must keep measuring after a breach stop. Returns None on TIMEOUT, which
    callers treat as a breach (fail closed: an adversary can make the size
    walk pathologically slow with millions of tiny files); returns 0 when
    docker is unavailable (nothing can be growing either)."""
    hit = _vol_usage_cache.get(slug)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    try:
        r = _docker("system", "df", "-v", "--format", "{{json .Volumes}}",
                    timeout=120)
    except subprocess.TimeoutExpired:
        return None
    except OSError:
        return 0
    if r.returncode != 0:
        return 0
    try:
        vols = json.loads(r.stdout or "[]")
    except json.JSONDecodeError:
        return 0
    prefix = f"orgtree-sys-{slug}-"
    total = sum(_parse_size(v.get("Size", "0B")) for v in vols
                if str(v.get("Name", "")).startswith(prefix))
    _vol_usage_cache[slug] = (time.time(), total)
    return total


def bridge_exec_env(org: Org) -> dict[str, str]:
    """Per-process provider proxy env for a sandboxed org.

    Standard mode leaves the container's historical auth env untouched.
    Frozen mode always routes through the bridge, including orgs configured
    with explicit API keys; only the host relay sees the provider credential.
    Resolving auth first preserves its fail-closed policy validation.
    """
    container_auth(org)
    if legacy_bridge_credentials_allowed():
        return {}
    credential = bridge_credential(org)
    return {
        "ANTHROPIC_BASE_URL": f"{bridge_url()}/anthropic/{credential}",
        "ANTHROPIC_API_KEY": "orgtree-proxied",
    }


def exec_argv(name: str, cwd: str,
              env: dict[str, str] | None = None) -> list[str]:
    """Prefix that runs a command inside the org's container."""
    args = ["docker", "exec", "-i", "-w", cwd]
    for key, value in sorted((env or {}).items()):
        args += ["-e", f"{key}={value}"]
    return args + [name]


def kill_claude(name: str, match: str = "claude") -> None:
    """Timeout hammer: killing the `docker exec` client on the host leaves the
    in-container process alive — reap it explicitly. `match` narrows the kill
    to one turn's process (its session id appears in the argv); the container
    is shared org-wide, so a blanket "claude" match would SIGKILL every other
    agent's turn too (gap audit №40)."""
    try:
        _docker("exec", name, "pkill", "-9", "-f", match, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        pass


_dead: set[str] = set()   # slugs deleted mid-warm-up (create/delete race)


def remove(slug: str) -> None:
    """Org deleted: tear the container AND its system volumes down (orphaned
    volumes are unmeasured GBs — exactly what the disk bound exists to stop;
    the org's FILES survive via the trash-rename of its doc + host dirs, but
    container system state follows the container). The tombstone closes the
    warm() race: deleting an org while its background prebuild was still
    creating the container used to leak it (rm -f fired before the container
    existed; observed in the wild)."""
    _dead.add(slug)
    try:
        _docker("rm", "-f", container_name(slug), timeout=60)
        _remove_frozen_gateway(slug)
        _docker("volume", "rm", "-f", *[sys_volume(slug, d) for d in SYS_DIRS],
                timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        pass
    from . import disk as dsk
    try:
        dsk.destroy(slug)
    except Exception:                                    # noqa: BLE001
        pass
    _disk_flag.pop(slug, None)


def warm(org: Org) -> None:
    """Fire-and-forget prebuild at kiosk creation so the first turn is not
    minutes slow (image build + container create)."""
    slug = org.d["slug"]
    _dead.discard(slug)          # same-slug re-create un-tombs it

    def run() -> None:
        try:
            ensure_container(org)
        except Exception as e:              # noqa: BLE001 — surfaced per turn
            print(f"[orgtree] sandbox warm-up for {slug!r}: {e}")
        if slug in _dead:        # deleted while we were building — tear down
            try:
                _docker("rm", "-f", container_name(slug), timeout=60)
                _remove_frozen_gateway(slug)
            except (OSError, subprocess.TimeoutExpired):
                pass
    threading.Thread(target=run, daemon=True).start()
