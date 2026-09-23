"""Bounded local named-pipe transport for the Windows service bridge.

The service owns the first pipe instance, rejects remote clients, and gives
the operator only read/write data rights (not instance-creation rights).
Each connection carries one length-prefixed JSON request and response.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import json
import msvcrt
import os
import struct
from typing import BinaryIO, Any


PIPE_NAME = r"\\.\pipe\OrgtreeEngineBridge"
MAX_FRAME = 65536
PIPE_ACCESS_DUPLEX = 0x3
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x80000
PIPE_REJECT_REMOTE_CLIENTS = 0x8
ERROR_PIPE_CONNECTED = 535


def _read_exact(stream: BinaryIO, size: int) -> bytes:
    result = bytearray()
    while len(result) < size:
        part = stream.read(size - len(result))
        if not part:
            raise EOFError("bridge connection closed during a frame")
        result.extend(part)
    return bytes(result)


def read_frame(stream: BinaryIO) -> dict[str, Any]:
    length = struct.unpack("<I", _read_exact(stream, 4))[0]
    if length == 0 or length > MAX_FRAME:
        raise ValueError("bridge frame size is invalid")
    value = json.loads(_read_exact(stream, length).decode("utf-8"))
    if not isinstance(value, dict):
        raise ValueError("bridge frame must be an object")
    return value


def write_frame(stream: BinaryIO, value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if not 0 < len(payload) <= MAX_FRAME:
        raise ValueError("bridge frame size is invalid")
    stream.write(struct.pack("<I", len(payload)) + payload)
    stream.flush()


class SecurityAttributes(ctypes.Structure):
    _fields_ = [("nLength", w.DWORD), ("lpSecurityDescriptor", ctypes.c_void_p),
                ("bInheritHandle", w.BOOL)]


class WindowsPipeAPI:
    def __init__(self, operator_sid: str) -> None:
        self.operator_sid = operator_sid
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel.CreateNamedPipeW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD,
                                                 w.DWORD, w.DWORD, w.DWORD, w.DWORD,
                                                 ctypes.POINTER(SecurityAttributes)]
        self.kernel.CreateNamedPipeW.restype = w.HANDLE
        self.kernel.ConnectNamedPipe.argtypes = [w.HANDLE, ctypes.c_void_p]
        self.kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p,
                                            w.DWORD, w.DWORD, w.HANDLE]
        self.kernel.CreateFileW.restype = w.HANDLE
        self.kernel.GetNamedPipeClientProcessId.argtypes = [w.HANDLE,
                                                             ctypes.POINTER(w.ULONG)]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.LocalFree.argtypes = [ctypes.c_void_p]
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
            w.LPCWSTR, w.DWORD, ctypes.POINTER(ctypes.c_void_p),
            ctypes.POINTER(w.ULONG)]
        self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL

    def new_instance(self, first: bool) -> int:
        # 0x00100003 = SYNCHRONIZE | FILE_READ_DATA | FILE_WRITE_DATA;
        # FILE_CREATE_PIPE_INSTANCE (0x4) is deliberately absent.
        sddl = f"O:SYD:P(A;;GA;;;SY)(A;;0x00100003;;;{self.operator_sid})"
        descriptor = ctypes.c_void_p()
        if not self.advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        attrs = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        try:
            handle = self.kernel.CreateNamedPipeW(
                PIPE_NAME, PIPE_ACCESS_DUPLEX |
                (FILE_FLAG_FIRST_PIPE_INSTANCE if first else 0),
                PIPE_REJECT_REMOTE_CLIENTS, 16, MAX_FRAME, MAX_FRAME, 0,
                ctypes.byref(attrs))
            if handle in (None, w.HANDLE(-1).value):
                raise ctypes.WinError(ctypes.get_last_error())
            return int(handle)
        finally:
            self.kernel.LocalFree(descriptor)

    def connect(self, handle: int) -> int:
        if not self.kernel.ConnectNamedPipe(w.HANDLE(handle), None):
            if ctypes.get_last_error() != ERROR_PIPE_CONNECTED:
                raise ctypes.WinError(ctypes.get_last_error())
        client = w.ULONG()
        if not self.kernel.GetNamedPipeClientProcessId(w.HANDLE(handle), ctypes.byref(client)):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(client.value)

    def open_client(self) -> BinaryIO:
        handle = self.kernel.CreateFileW(PIPE_NAME, 0x00100003, 0, None, 3, 0, None)
        if handle in (None, w.HANDLE(-1).value):
            raise ctypes.WinError(ctypes.get_last_error())
        return self.stream(int(handle))

    def stream(self, handle: int) -> BinaryIO:
        fd = msvcrt.open_osfhandle(handle, os.O_BINARY | os.O_RDWR)
        return os.fdopen(fd, "r+b", buffering=0)

    def close(self, handle: int) -> None:
        self.kernel.CloseHandle(w.HANDLE(handle))
