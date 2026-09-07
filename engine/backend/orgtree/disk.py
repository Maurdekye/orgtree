# pyright: strict
"""Per-org virtual disks (user verdict 2026-07-31): ONE ext4 image per org
with a FILESYSTEM-level hard cap.

The shape (feasibility-spiked end-to-end, no Windows admin anywhere):

    docker volume  orgtree-disk-<slug>     durable home of the image file
      └─ disk.img                          fixed-size sparse file, ext4
    loop-mounted INSIDE the docker-desktop distro (distro root ≠ host admin)
      at /mnt/wsl/orgtree-disk/<slug>      /mnt/wsl is shared across distros:
                                           containers bind it, and the Windows
                                           backend reads it via \\wsl.localhost
                                           — including DELETES AT 100% FULL
                                           (verified, not assumed)

※ The image is mounted EXACTLY ONCE, in the distro; every consumer (container
binds, the backend's UNC reads, the recovery browser) reaches that single
mount. Mounting the image a second time from anywhere is a double-mount of one
block device and corrupts the filesystem silently — never "optimise" that way.

⚠ /mnt/wsl is torn down whenever the WSL VM stops (reboot, wsl --shutdown,
Docker Desktop restart) and Docker CREATES AN EMPTY DIR for a missing bind
source rather than erroring. An org whose disk didn't remount would silently
bind an empty workspace and diverge. Hence the SENTINEL: a marker file written
into the filesystem root at creation; `is_mounted` demands it, and container
starts must hard-refuse when it is absent (sandbox.ensure_container does).

The ENOSPC cap is the enforcement: no quota mechanism, no container-stop —
a full disk fails writes at the filesystem while the engine and the recovery
browser keep working. Docker Desktop's VM disk cap remains the host-level
backstop for the sum of all disks (sparse images grow the VHDX as written).
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
import time
from typing import cast

SENTINEL = ".orgtree-disk"
IMG = "disk.img"
# ⚠ NOT a constant: Docker Desktop MOVED the shared mount, and hardcoding it
# broke sandboxed-org creation on this machine with no orgtree change involved.
#
# The design wants the ONE tmpfs WSL shares across distros — containers bind
# it, and the Windows backend reads the same bytes over \\wsl.localhost. That
# tmpfs used to be at `/mnt/wsl` inside the docker-desktop distro. A Docker
# Desktop update put the distro in its own mount namespace and remapped the
# host mounts under `/mnt/host/`, so `/mnt/wsl` there became a plain directory
# on a READ-ONLY overlay root — with the previously-created org mountpoints
# still baked into it, which is why existing orgs kept working (`mkdir -p`
# returns 0 on an existing dir) while every NEW slug failed on a read-only
# filesystem. Measured 2026-08-04: docker-desktop had 0 mounts under
# `/mnt/wsl`, Ubuntu-24.04 had 9, and `/mnt/host/wsl` in the distro listed the
# very same contents as `/mnt/wsl` in Ubuntu.
#
# `wsl --shutdown` does NOT fix it (tried) — the namespace split is by design,
# not a damaged disk. So the root is DETECTED, in the same spirit as `distro()`
# right below, and both spellings are accepted so the same code runs on the
# older and newer Docker Desktop layouts. Both were verified reachable from
# Windows over \\wsl.localhost before this was written.
_MOUNT_ROOTS = ("/mnt/host/wsl", "/mnt/wsl")
_mount_root_cache: str | None = None


def mount_root() -> str:
    """The shared-tmpfs directory holding every org's mountpoint.

    Fails loud, like `distro()`: an org whose disk cannot be mounted must say
    what is missing rather than silently bind an empty workspace."""
    global _mount_root_cache
    if _mount_root_cache:
        return _mount_root_cache
    for base in _MOUNT_ROOTS:
        # writability is the test, not existence — `/mnt/wsl` still EXISTS in
        # the new layout, on a read-only root, which is exactly the trap.
        if _sh(f"mkdir -p {base}/orgtree-disk").returncode == 0:
            _mount_root_cache = f"{base}/orgtree-disk"
            return _mount_root_cache
    raise RuntimeError(
        "no writable shared mount root inside the Docker Desktop distro "
        f"(tried {', '.join(_MOUNT_ROOTS)}). Sandboxed orgs cannot be "
        "created or started until one of these is writable.")
# distro-side candidates for the docker daemon's data root (the volume
# Mountpoint docker reports is the DAEMON namespace path, not the distro's)
_DATA_ROOTS = ("/mnt/docker-desktop-disk/data/docker/volumes",
               "/var/lib/docker/volumes")

_lock = threading.Lock()
_distro_cache: str | None = None
_dataroot_cache: str | None = None


class DiskError(RuntimeError):
    """Actionable per-org disk failure. Message is user-facing."""


def _run(args: list[str], timeout: int = 60) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args, capture_output=True, text=True, timeout=timeout,
        creationflags=(subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                       if os.name == "nt" else 0))


def distro() -> str:
    """The Docker Desktop WSL distro, DETECTED not hardcoded (the name and
    the docker-desktop/docker-desktop-data split have moved across Docker
    Desktop versions). Fails loud: an org whose disk cannot be mounted must
    say what is missing, never present as an empty workspace."""
    global _distro_cache
    if _distro_cache:
        return _distro_cache
    r = _run(["wsl", "-l", "-q"])
    if r.returncode != 0:
        raise DiskError("WSL is unavailable — org disks need Docker Desktop's "
                        "WSL2 backend running")
    # wsl.exe emits UTF-16-ish output through text mode: strip NULs
    names = [n.strip().lstrip("*").strip() for n in
             r.stdout.replace("\x00", "").splitlines() if n.strip()]
    cand = [n for n in names if n == "docker-desktop"] \
        or [n for n in names if "docker-desktop" in n
            and "data" not in n]
    if not cand:
        raise DiskError(f"no docker-desktop WSL distro found (have: {names}) "
                        f"— is Docker Desktop installed with the WSL2 backend?")
    _distro_cache = cand[0]
    return cand[0]


def _sh(script: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    """Run a shell line inside the distro (distro default user is root)."""
    return _run(["wsl", "-d", distro(), "-e", "sh", "-c", script],
                timeout=timeout)


def _data_root() -> str:
    global _dataroot_cache
    if _dataroot_cache:
        return _dataroot_cache
    for c in _DATA_ROOTS:
        if _sh(f"test -d {c}").returncode == 0:
            _dataroot_cache = c
            return c
    raise DiskError("cannot locate the docker volumes dir inside the distro "
                    f"(tried {', '.join(_DATA_ROOTS)}) — Docker Desktop "
                    f"layout changed; update orgtree.disk._DATA_ROOTS")


def disk_volume(slug: str) -> str:
    return f"orgtree-disk-{slug}"


def _img_path(slug: str) -> str:
    return f"{_data_root()}/{disk_volume(slug)}/_data/{IMG}"


def mount_path(slug: str) -> str:
    return f"{mount_root()}/{slug}"


def windows_path(slug: str) -> str:
    r"""The Windows-side view of the MOUNTED disk (\\wsl.localhost UNC).
    Read/download/unlink only — enumeration over this path is 9p-slow;
    list with `enumerate_by_size` (runs inside the distro) instead."""
    return rf"\\wsl.localhost\{distro()}{mount_path(slug).replace('/', chr(92))}"


# the on-disk layout (one disk, everything on it — user verdict):
#   home/       the container's /home/agent (transcripts ~/.claude included)
#   workspace/  the org workspace (container cpath_workspace)
#   scratch/    node scratch dirs (container <data>/scratch/<slug>)
#   usr/ var/ etc/ opt/ root/ srv/   system dirs, seeded once
SUBDIRS = ("home", "workspace", "scratch", "usr", "var", "etc", "opt",
           "root", "srv")


def windows_sub(slug: str, sub: str) -> str:
    r"""Windows-side path of one on-disk subdir (backend readers/writers)."""
    return os.path.join(windows_path(slug), sub)


def exists(slug: str) -> bool:
    return _sh(f"test -f {_img_path(slug)}").returncode == 0


def is_mounted(slug: str) -> bool:
    """Mounted AND ours: the sentinel distinguishes a live mount from the
    empty directory Docker mints for a missing bind source."""
    return _sh(f"test -f {mount_path(slug)}/{SENTINEL}").returncode == 0


def create(slug: str, size_mb: int) -> None:
    """Volume + sparse fixed-size image + ext4 + sentinel, then mounted.
    Idempotent: an existing image is left untouched (just ensures the mount).
    Sparse: the file consumes VHDX space only as written; the CAP is the
    filesystem's own size — ENOSPC at the limit, no quota machinery."""
    if size_mb < 16:
        raise DiskError("org disk must be at least 16 MB")
    with _lock:
        r = _run(["docker", "volume", "create", disk_volume(slug)])
        if r.returncode != 0:
            raise DiskError("docker volume create failed: "
                            + (r.stderr or r.stdout)[-300:])
        img = _img_path(slug)
        if _sh(f"test -f {img}").returncode != 0:
            # -m 0: NO reserved-for-root blocks. ext4's 5% default reserve is
            # for a system disk that must not wedge root; this image holds one
            # org's data and the container's CLI runs as an unprivileged user,
            # so the reserve is simply 5% of the cap the operator paid for
            # that agents can never use — and it makes the ≥99% "hard full"
            # tier unreachable: measured on a real 4096 MB org disk, the CLI's
            # writes hit ENOSPC with `df` reading 94.4% (test_sandbox.py §9),
            # so the alert state that tier exists to raise could not fire.
            # Applies to NEWLY created disks; an existing one can be migrated
            # with `tune2fs -m 0 <img>` (not done automatically — it is the
            # operator's disk).
            mk = _sh(f"dd if=/dev/zero of={img} bs=1M count=0 seek={size_mb} "
                     f"2>/dev/null && mkfs.ext4 -q -m 0 {img}", timeout=300)
            if mk.returncode != 0:
                _sh(f"rm -f {img}")
                raise DiskError("org disk format failed: "
                                + (mk.stderr or mk.stdout)[-300:])
    mount(slug)
    # sentinel + open root perms, written exactly once, while mounted — the
    # sentinel's later ABSENCE means "not mounted". Mode not chown: the
    # sandbox image's agent uid is 1001 (node:22-slim already owns 1000),
    # and pinning any uid here breaks when the image changes.
    st = _sh(f"test -f {mount_path(slug)}/{SENTINEL} || "
             f"(chmod 0777 {mount_path(slug)} && "
             f" touch {mount_path(slug)}/{SENTINEL})")
    if st.returncode != 0:
        raise DiskError("org disk sentinel write failed: "
                        + (st.stderr or st.stdout)[-300:])


def mount(slug: str) -> None:
    """Idempotent loop mount at the shared path. ⚠ single-mount property:
    this is the ONLY place the image may ever be mounted (see module doc)."""
    with _lock:
        if is_mounted(slug):
            return
        if not exists(slug):
            raise DiskError(f"org {slug!r} has no disk image — create it "
                            f"(or the docker volume {disk_volume(slug)!r} "
                            f"was removed)")
        mp = mount_path(slug)
        r = _sh(f"mkdir -p {mp} && mountpoint -q {mp} || "
                f"mount -o loop {_img_path(slug)} {mp}", timeout=120)
        if r.returncode != 0:
            raise DiskError(f"org disk mount failed for {slug!r}: "
                            + (r.stderr or r.stdout)[-300:])


def unmount(slug: str) -> None:
    with _lock:
        _sh(f"umount {mount_path(slug)} 2>/dev/null; "
            f"rmdir {mount_path(slug)} 2>/dev/null")


def destroy(slug: str) -> None:
    """Org deleted: unmount and drop the volume (the image goes with it)."""
    unmount(slug)
    try:
        _run(["docker", "volume", "rm", "-f", disk_volume(slug)])
    except (OSError, subprocess.TimeoutExpired):
        pass


_usage_cache: dict[str, tuple[float, tuple[int, int]]] = {}


def usage(slug: str, max_age: float = 15.0) -> tuple[int, int] | None:
    """(used, total) bytes from df INSIDE the distro — exact, fast, and alive
    regardless of any container's state. None = disk not mounted."""
    hit = _usage_cache.get(slug)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    if not is_mounted(slug):
        return None
    # busybox df (no --output; ⚠ busybox also exits 0 on unknown flags,
    # printing help — key off parsed columns, not the return code)
    r = _sh(f"df -k {mount_path(slug)} | tail -1")
    m = re.match(r"\S+\s+(\d+)\s+(\d+)\s+\d+", r.stdout or "")
    if not m:
        return None
    out = (int(m.group(2)) * 1024, int(m.group(1)) * 1024)
    _usage_cache[slug] = (time.time(), out)
    return out


def invalidate(slug: str) -> None:
    """Drop the cached usage after deletes so the readout moves immediately."""
    _usage_cache.pop(slug, None)
    _tree_cache.pop(slug, None)


# ---- the directory tree (recovery-browser mode 2, user request) -----------
# ONE walk inside the distro produces both browser views: the flat by-size
# list and the explorer. The walk yields every file (size) and every dir;
# aggregates roll up the tree in python and ONE LEVEL is served per request —
# a measured org holds 99k files and the full tree must never ship to the
# browser. Cached beside usage (same TTL family, same invalidate on delete).
# Children map: parent rel-path → {name: (is_dir, bytes, file_count)}.
_tree_cache: dict[str, tuple[float, dict[str, dict[str, tuple[bool, int, int]]]]] = {}


def _dir_children(slug: str, max_age: float = 15.0) \
        -> dict[str, dict[str, tuple[bool, int, int]]]:
    hit = _tree_cache.get(slug)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    mp = mount_path(slug)
    if not is_mounted(slug):
        raise DiskError(f"org {slug!r} disk is not mounted")
    # one pass: F<size>@<rel> per file, D@<rel> per dir (busybox find:
    # no -printf, and it exits 0 even on flag errors — trust the parse)
    r = _sh(f"cd {mp} && find . -type f -exec stat -c 'F%s@%n' {{}} + ; "
            f"cd {mp} && find . -type d ! -name . | sed 's/^/D@/'",
            timeout=180)
    if r.returncode != 0:
        raise DiskError("disk tree walk failed: "
                        + (r.stderr or r.stdout)[-300:])
    kids: dict[str, dict[str, tuple[bool, int, int]]] = {"": {}}

    def norm(rel: str) -> str:
        return rel[2:] if rel.startswith("./") else rel

    for line in (r.stdout or "").splitlines():
        if line.startswith("D@"):
            rel = norm(line[2:])
            if not rel:
                continue
            parent, _, name = rel.rpartition("/")
            kids.setdefault(parent, {}).setdefault(name, (True, 0, 0))
            kids.setdefault(rel, {})
        elif line.startswith("F"):
            size_s, sep, rel = line[1:].partition("@")
            rel = norm(rel)
            if not sep or not size_s.isdigit() or rel == SENTINEL:
                continue
            size = int(size_s)
            parent, _, name = rel.rpartition("/")
            kids.setdefault(parent, {})[name] = (False, size, 1)
            # roll the size up every ancestor directory
            while parent:
                gp, _, pname = parent.rpartition("/")
                d = kids.setdefault(gp, {})
                was = d.get(pname, (True, 0, 0))
                d[pname] = (True, was[1] + size, was[2] + 1)
                parent = gp
    _tree_cache[slug] = (time.time(), kids)
    return kids


def list_dir(slug: str, rel: str = "",
             max_age: float = 15.0) -> list[dict[str, object]]:
    """ONE level of the explorer, entries (dirs AND files) INTERMIXED by size
    descending — deliberate deviation from folders-first convention: the
    view exists for size triage, so a 900 MB folder outranks a 200 MB file."""
    kids = _dir_children(slug, max_age=max_age)
    if rel not in kids:
        raise DiskError(f"no such directory on the org disk: {rel!r}")
    out: list[dict[str, object]] = [
        {"name": n, "path": f"{rel}/{n}" if rel else n, "dir": is_dir,
         "bytes": size, "files": count}
        for n, (is_dir, size, count) in kids[rel].items()]
    out.sort(key=lambda e: (-int(cast(int, e["bytes"])), str(e["name"])))
    return out


def subtree_files(slug: str, rel: str,
                  max_age: float = 15.0) -> list[tuple[str, int]]:
    """Every file under a directory (for recursive delete classification) —
    served from the cached walk, no re-walk per subtree."""
    kids = _dir_children(slug, max_age=max_age)
    out: list[tuple[str, int]] = []
    stack = [rel]
    while stack:
        d = stack.pop()
        for n, (is_dir, size, _c) in (kids.get(d) or {}).items():
            p = f"{d}/{n}" if d else n
            if is_dir:
                stack.append(p)
            else:
                out.append((p, size))
    return out


def grow(slug: str, new_size_mb: int) -> None:
    """GROW is online (user-adopted resize rule): extend the sparse file,
    resize2fs while mounted. Shrink is a different, OFFLINE operation —
    shrink_image below, reached via the staged pending-shrink flow (applied
    only when the org's container is down); this function refuses it."""
    u = usage(slug, max_age=0.0)
    if u and new_size_mb * 1048576 < u[1]:
        raise DiskError("grow() cannot shrink — the disk is "
                        f"{u[1] // 1048576} MB")
    img = _img_path(slug)
    # losetup -c: the loop device caches its size at attach time — without
    # the capacity refresh, resize2fs sees the old bound and no-ops
    r = _sh(f"truncate -s {new_size_mb}M {img} && "
            f"DEV=$(losetup -j {img} | cut -d: -f1) && "
            f"losetup -c $DEV && resize2fs $DEV", timeout=300)
    if r.returncode != 0:
        raise DiskError("org disk grow failed: "
                        + (r.stderr or r.stdout)[-300:])
    _usage_cache.pop(slug, None)


def shrink_image(slug: str, new_size_mb: int) -> None:
    """OFFLINE shrink (pending-shrink design, user-ruled): the CALLER
    guarantees the org's container is down — only that org's agents pause,
    never the backend (each org's mount is independent and the backend reads
    over UNC with transient handles). Sequence: unmount → forced fsck →
    resize2fs to the target → truncate the sparse file down → caller
    remounts. Usage-fit is the CALLER's check (refuse-not-guess: never
    partially apply)."""
    img = _img_path(slug)
    with _lock:
        r = _sh(f"umount {mount_path(slug)} 2>/dev/null; "
                f"e2fsck -fy {img} >/dev/null && "
                f"resize2fs {img} {new_size_mb}M && "
                f"truncate -s {new_size_mb}M {img}", timeout=600)
        if r.returncode != 0:
            raise DiskError("org disk shrink failed (nothing was truncated "
                            "unless resize2fs succeeded): "
                            + (r.stderr or r.stdout)[-300:])
    _usage_cache.pop(slug, None)
    _tree_cache.pop(slug, None)


def enumerate_by_size(slug: str, limit: int = 500,
                      offset: int = 0) -> list[dict[str, object]]:
    """Recovery-browser listing: files by size DESCENDING, computed INSIDE
    the distro (a UNC/9p walk of a 99k-file org would take minutes at the
    exact moment everything is wedged). Works with every container stopped."""
    mp = mount_path(slug)
    if not is_mounted(slug):
        raise DiskError(f"org {slug!r} disk is not mounted")
    # busybox find has no -printf; stat -c does exist. '@' as the separator
    # (paths may contain tabs in principle, never '@' at position 0 of the
    # size field). ⚠ busybox exits 0 even on flag errors — trust the parse.
    #
    # ⚠ Paging is `tail -n +N | head -M`, NOT `head -(offset+limit) | tail
    # -limit`. The latter reads correctly and is wrong: `head -N` CLAMPS to
    # the real line count once N overshoots it, and `tail -limit` then
    # measures "the last `limit`" from the clamped list rather than from
    # `offset`. Measured on a 12-file disk: offset=8 limit=10 returned TEN
    # rows starting at file 3 — six of them already served on the previous
    # page — and offset=12 (exactly past the end) returned the last five
    # files instead of nothing. Both land precisely where a "load more"
    # button naturally goes, at the end of a long listing.
    r = _sh(f"cd {mp} && find . -type f -exec stat -c '%s@%n' {{}} + "
            f"| sort -rn | tail -n +{offset + 1} | head -{limit}",
            timeout=120)
    if r.returncode != 0:
        raise DiskError("disk enumeration failed: "
                        + (r.stderr or r.stdout)[-300:])
    out: list[dict[str, object]] = []
    for line in (r.stdout or "").splitlines():
        size, sep, rel = line.partition("@")
        rel = rel[2:] if rel.startswith("./") else rel
        if sep and rel and rel != SENTINEL and size.isdigit():
            out.append({"path": rel, "bytes": int(size)})
    return out
