"""Authenticated service endpoint for signed-in-user agent processes.

Only a same-operator process inside this host's service-owned job AND holding
the per-host secret may call it. The pipe is local-only with a restrictive
DACL. Service credentials and user token handles never cross this boundary;
only stdio and limited process handles are duplicated into the engine.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import hmac
from pathlib import Path
import threading
from typing import Any, Callable

from .bridge_policy import allows_google_subscription
from .bridge_spawn import BridgeSpawnAPI, BridgedChild
from .bridge_state import BridgeState
from .bridge_transport import WindowsPipeAPI, read_frame, write_frame
from .session_token import TOKEN_USER, WindowsSessionTokens


PROCESS_DUP_HANDLE = 0x40
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
TOKEN_QUERY = 0x8


class BridgeServer:
    def __init__(self, operator_sid: str, host_job: int, secret: str,
                 state: BridgeState[int], *, host_pid: int, profile_path: Path,
                 pipe: WindowsPipeAPI | None = None,
                 spawner: BridgeSpawnAPI | None = None,
                 policy: Callable[[Path, list[str], str, dict[str, str]], bool] = allows_google_subscription):
        if len(secret) != 64 or any(ch not in "0123456789abcdef" for ch in secret):
            raise ValueError("bridge requires a fresh 256-bit hex secret")
        self.operator_sid = operator_sid
        self.host_job = host_job
        if host_pid <= 0:
            raise ValueError("bridge requires the exact host PID")
        self.host_pid = host_pid
        self.engine_pid: int | None = None
        self.profile_path = profile_path
        self.policy = policy
        self.secret = secret
        self.state = state
        self.pipe = pipe or WindowsPipeAPI(operator_sid)
        self.spawner = spawner or BridgeSpawnAPI()
        self.tokens = WindowsSessionTokens()
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        self.kernel.OpenProcess.restype = w.HANDLE
        self.kernel.IsProcessInJob.argtypes = [w.HANDLE, w.HANDLE, ctypes.POINTER(w.BOOL)]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.advapi.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._spawn_lock = threading.Lock()
        self._turns: dict[str, BridgedChild] = {}
        self._watchers: set[threading.Thread] = set()
        self._slots = threading.BoundedSemaphore(16)
        self._first_listener = 0

    def _peer(self, pid: int) -> int:
        process = self.kernel.OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION,
                                          False, pid)
        if not process:
            raise PermissionError("bridge client process is unavailable")
        process = int(process)
        try:
            inside = w.BOOL()
            if not self.kernel.IsProcessInJob(w.HANDLE(process), w.HANDLE(self.host_job),
                                               ctypes.byref(inside)) or not inside.value:
                raise PermissionError("bridge client is outside the engine job")
            token = w.HANDLE()
            if not self.advapi.OpenProcessToken(w.HANDLE(process), TOKEN_QUERY,
                                                ctypes.byref(token)):
                raise PermissionError("bridge client token is unavailable")
            try:
                user = self.tokens._information(int(token.value), TOKEN_USER)
                sid_pointer = ctypes.c_void_p.from_buffer(user).value
                if not sid_pointer or self.tokens._sid(sid_pointer) != self.operator_sid:
                    raise PermissionError("bridge client is not the operator")
            finally:
                self.tokens.close(int(token.value))
            return process
        except BaseException:
            self.kernel.CloseHandle(w.HANDLE(process))
            raise

    def _watch(self, turn_id: str, child: BridgedChild) -> None:
        confirmed_exit = False
        try:
            child.wait(None)
            confirmed_exit = True
        except OSError:
            try:
                child.terminate()
                confirmed_exit = child.wait(10) is not None
            except OSError:
                pass
        finally:
            try:
                child.close()  # close the kill-on-close job before releasing its token
            finally:
                if confirmed_exit:
                    self.state.finish_turn(turn_id)
                with self._lock:
                    self._turns.pop(turn_id, None)
                    self._watchers.discard(threading.current_thread())

    def _spawn(self, request: dict[str, Any], peer: int) -> dict[str, Any]:
        # Serialize service stop with the whole create/publish operation.
        with self._spawn_lock:
            if self._stop.is_set():
                return {"ok": False, "code": "service-stopping"}
            return self._spawn_locked(request, peer)

    def _spawn_locked(self, request: dict[str, Any], peer: int) -> dict[str, Any]:
        turn_id = request.get("turnId")
        argv = request.get("argv")
        cwd = request.get("cwd")
        env = request.get("env")
        if (not isinstance(turn_id, str) or not 0 < len(turn_id) <= 128
                or not isinstance(argv, list) or not isinstance(cwd, str)
                or not isinstance(env, dict)):
            return {"ok": False, "code": "invalid-request"}
        if (not all(isinstance(arg, str) for arg in argv)
                or not all(isinstance(k, str) and isinstance(v, str)
                           for k, v in env.items())
                or not self.policy(self.profile_path, argv, cwd, env)):
            return {"ok": False, "code": "provider-custody-not-allowed"}
        token = self.state.begin_turn(turn_id)
        if token is None:
            return {"ok": False, "code": "waiting-for-sign-in"}
        child = None
        try:
            child = self.spawner.create_suspended(token, argv, cwd, env)
            if not self.state.commit_turn(turn_id, child.resume):
                return {"ok": False, "code": "signed-out-before-spawn"}
            handles = child.publish(peer)
            with self._lock:
                self._turns[turn_id] = child
                watcher = threading.Thread(target=self._watch, args=(turn_id, child),
                                            daemon=True, name="orgtree-bridge-turn")
                self._watchers.add(watcher)
                watcher.start()
            return {"ok": True, **handles}
        except (OSError, ValueError, PermissionError):
            return {"ok": False, "code": "bridge-spawn-failed"}
        finally:
            if child is None or turn_id not in self._turns:
                if child is not None:
                    child.close()
                self.state.finish_turn(turn_id)

    def _dispatch(self, request: dict[str, Any], peer: int, pid: int) -> dict[str, Any]:
        supplied = request.get("secret")
        if not isinstance(supplied, str) or not hmac.compare_digest(supplied, self.secret):
            raise PermissionError("bridge authentication failed")
        if self._stop.is_set():
            return {"ok": False, "code": "service-stopping"}
        operation = request.get("op")
        if operation == "register":
            engine_pid = request.get("enginePid")
            if pid != self.host_pid or not isinstance(engine_pid, int) or engine_pid <= 0:
                raise PermissionError("only the exact host can register its engine")
            # Verify that the claimed process belongs to this host job and
            # operator before binding the pipe's entire lifetime to its PID.
            verified = self._peer(engine_pid)
            self.kernel.CloseHandle(w.HANDLE(verified))
            with self._lock:
                if self.engine_pid is not None and self.engine_pid != engine_pid:
                    raise PermissionError("bridge engine identity changed")
                self.engine_pid = engine_pid
            return {"ok": True}
        with self._lock:
            if pid != self.engine_pid:
                raise PermissionError("bridge caller is not the registered engine")
        if operation == "state":
            return {"ok": True, **self.state.status()}
        if operation == "spawn":
            return self._spawn(request, peer)
        if operation == "terminate":
            turn_id = request.get("turnId")
            with self._lock:
                child = self._turns.get(turn_id) if isinstance(turn_id, str) else None
            if child is None:
                return {"ok": False, "code": "unknown-turn"}
            child.terminate()
            return {"ok": True}
        return {"ok": False, "code": "invalid-operation"}

    def _serve_connection(self, pipe_handle: int, pid: int) -> None:
        peer = 0
        spawned_turn: str | None = None
        try:
            peer = self._peer(pid)
            with self.pipe.stream(pipe_handle) as stream:
                pipe_handle = 0  # stream now owns it
                request = read_frame(stream)
                response = self._dispatch(request, peer, pid)
                if request.get("op") == "spawn" and response.get("ok") is True:
                    spawned_turn = request["turnId"]
                write_frame(stream, response)
                spawned_turn = None
        except (OSError, EOFError, ValueError, PermissionError):
            pass  # fail closed; no secret or token appears in diagnostics
        finally:
            # If the response never reached the engine, the spawned process
            # has no owner there. A successful delivery transfers ownership.
            if spawned_turn is not None:
                with self._lock:
                    orphan = self._turns.get(spawned_turn)
                if orphan is not None:
                    try:
                        orphan.terminate()
                    except OSError:
                        pass
            if peer:
                self.kernel.CloseHandle(w.HANDLE(peer))
            if pipe_handle:
                self.pipe.close(pipe_handle)
            self._slots.release()

    def _serve(self) -> None:
        listener = self._first_listener
        self._first_listener = 0
        try:
            while not self._stop.is_set():
                pid = self.pipe.connect(listener)
                if self._stop.is_set():
                    break
                next_listener = self.pipe.new_instance(False)
                while not self._stop.is_set() and not self._slots.acquire(timeout=0.5):
                    pass
                if self._stop.is_set():
                    self.pipe.close(next_listener)
                    break
                thread = threading.Thread(target=self._serve_connection,
                                          args=(listener, pid), daemon=True,
                                          name="orgtree-bridge-client")
                thread.start()
                listener = next_listener
        except OSError:
            self._stop.set()
            self.state.stop_admitting()
        finally:
            if listener:
                self.pipe.close(listener)

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("bridge server already started")
        self._first_listener = self.pipe.new_instance(True)
        self._thread = threading.Thread(target=self._serve, daemon=True,
                                        name="orgtree-bridge-server")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            try:
                with self.pipe.open_client():
                    pass  # unblock ConnectNamedPipe
            except OSError:
                pass
            self._thread.join(timeout=5)
        with self._spawn_lock:
            with self._lock:
                children = list(self._turns.values())
                watchers = list(self._watchers)
        for child in children:
            try:
                child.terminate()
            except OSError:
                pass
        for watcher in watchers:
            watcher.join(timeout=10)
