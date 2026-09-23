"""Read a real Windows sign-in token for the configured operator.

This adapter never creates a logon session. The caller must be LocalSystem;
WTSQueryUserToken requires SeTcbPrivilege. Every failure closes the token and
leaves the bridge unavailable. The returned handle belongs to the caller.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w
from dataclasses import dataclass


TOKEN_USER = 1
TOKEN_STATISTICS = 10
TOKEN_SESSION_ID = 12
TOKEN_ELEVATION_TYPE = 18
TOKEN_INTEGRITY_LEVEL = 25
INTERACTIVE_LOGON_TYPES = frozenset({2, 10, 11})
MEDIUM_INTEGRITY = 0x2000


class Luid(ctypes.Structure):
    _fields_ = [("LowPart", w.DWORD), ("HighPart", w.LONG)]


class TokenStatistics(ctypes.Structure):
    _fields_ = [("TokenId", Luid), ("AuthenticationId", Luid),
                ("ExpirationTime", ctypes.c_int64), ("TokenType", w.DWORD),
                ("ImpersonationLevel", w.DWORD), ("DynamicCharged", w.DWORD),
                ("DynamicAvailable", w.DWORD), ("GroupCount", w.DWORD),
                ("PrivilegeCount", w.DWORD), ("ModifiedId", Luid)]


class UnicodeString(ctypes.Structure):
    _fields_ = [("Length", w.USHORT), ("MaximumLength", w.USHORT),
                ("Buffer", w.LPWSTR)]


class LogonSessionData(ctypes.Structure):
    _fields_ = [("Size", w.ULONG), ("LogonId", Luid),
                ("UserName", UnicodeString), ("LogonDomain", UnicodeString),
                ("AuthenticationPackage", UnicodeString), ("LogonType", w.ULONG),
                ("Session", w.ULONG), ("Sid", ctypes.c_void_p)]


@dataclass(frozen=True)
class TokenFacts:
    sid: str
    session_id: int
    logon_type: int
    elevation_type: int
    integrity_rid: int


def valid_operator_logon(facts: TokenFacts, operator_sid: str,
                         session_id: int) -> bool:
    """Refuse a foreign, elevated, synthetic or misplaced token."""
    return (facts.sid == operator_sid and facts.session_id == session_id
            and session_id > 0 and facts.logon_type in INTERACTIVE_LOGON_TYPES
            and facts.elevation_type in (1, 3)
            and facts.integrity_rid == MEDIUM_INTEGRITY)


class WindowsSessionTokens:
    def __init__(self) -> None:
        self.wts = ctypes.WinDLL("wtsapi32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.secur = ctypes.WinDLL("secur32", use_last_error=True)
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.wts.WTSQueryUserToken.argtypes = [w.ULONG, ctypes.POINTER(w.HANDLE)]
        self.wts.WTSQueryUserToken.restype = w.BOOL
        self.advapi.GetTokenInformation.argtypes = [w.HANDLE, w.DWORD, ctypes.c_void_p,
                                                    w.DWORD, ctypes.POINTER(w.DWORD)]
        self.advapi.GetTokenInformation.restype = w.BOOL
        self.advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(w.LPWSTR)]
        self.advapi.ConvertSidToStringSidW.restype = w.BOOL
        self.advapi.GetSidSubAuthorityCount.argtypes = [ctypes.c_void_p]
        self.advapi.GetSidSubAuthorityCount.restype = ctypes.POINTER(ctypes.c_ubyte)
        self.advapi.GetSidSubAuthority.argtypes = [ctypes.c_void_p, w.DWORD]
        self.advapi.GetSidSubAuthority.restype = ctypes.POINTER(w.DWORD)
        self.secur.LsaGetLogonSessionData.argtypes = [ctypes.POINTER(Luid),
                                                       ctypes.POINTER(ctypes.c_void_p)]
        self.secur.LsaGetLogonSessionData.restype = w.LONG
        self.secur.LsaFreeReturnBuffer.argtypes = [ctypes.c_void_p]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.LocalFree.argtypes = [ctypes.c_void_p]

    def close(self, token: int) -> None:
        if token:
            self.kernel.CloseHandle(w.HANDLE(token))

    def _information(self, token: int, kind: int) -> ctypes.Array:
        size = w.DWORD()
        self.advapi.GetTokenInformation(w.HANDLE(token), kind, None, 0, ctypes.byref(size))
        if not 0 < size.value <= 65536:
            raise OSError("Windows token information size is invalid")
        buffer = ctypes.create_string_buffer(size.value)
        if not self.advapi.GetTokenInformation(w.HANDLE(token), kind, buffer,
                                               size, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        return buffer

    def _sid(self, pointer: int) -> str:
        text = w.LPWSTR()
        if not self.advapi.ConvertSidToStringSidW(pointer, ctypes.byref(text)):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return text.value
        finally:
            self.kernel.LocalFree(ctypes.cast(text, ctypes.c_void_p))

    def facts(self, token: int) -> TokenFacts:
        user = self._information(token, TOKEN_USER)
        sid_pointer = ctypes.c_void_p.from_buffer(user).value
        if not sid_pointer:
            raise OSError("Windows token has no user SID")
        sid = self._sid(sid_pointer)
        session = w.DWORD.from_buffer(self._information(token, TOKEN_SESSION_ID)).value
        elevation = w.DWORD.from_buffer(self._information(token, TOKEN_ELEVATION_TYPE)).value
        integrity = self._information(token, TOKEN_INTEGRITY_LEVEL)
        integrity_sid = ctypes.c_void_p.from_buffer(integrity).value
        if not integrity_sid:
            raise OSError("Windows token has no integrity SID")
        count = self.advapi.GetSidSubAuthorityCount(integrity_sid)
        if not count or count[0] == 0:
            raise OSError("Windows token integrity SID is invalid")
        rid = self.advapi.GetSidSubAuthority(integrity_sid, count[0] - 1)[0]
        statistics = TokenStatistics.from_buffer(self._information(token, TOKEN_STATISTICS))
        data = ctypes.c_void_p()
        status = self.secur.LsaGetLogonSessionData(ctypes.byref(statistics.AuthenticationId),
                                                   ctypes.byref(data))
        if status or not data.value:
            raise OSError("Windows logon session could not be verified")
        try:
            logon = ctypes.cast(data, ctypes.POINTER(LogonSessionData)).contents
            return TokenFacts(sid, session, logon.LogonType, elevation, rid)
        finally:
            self.secur.LsaFreeReturnBuffer(data)

    def query_verified(self, session_id: int, operator_sid: str) -> int:
        token = w.HANDLE()
        if not self.wts.WTSQueryUserToken(session_id, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        handle = int(token.value)
        try:
            if not valid_operator_logon(self.facts(handle), operator_sid, session_id):
                raise PermissionError("session token is not a filtered, genuine operator logon")
            return handle
        except BaseException:
            self.close(handle)
            raise
