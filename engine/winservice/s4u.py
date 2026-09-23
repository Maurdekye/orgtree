"""Passwordless, non-interactive operator identity for the boot engine.

The service is LocalSystem and uses the MSV1_0 S4U package to obtain a batch
logon token. This token can access local profile files, but it carries no
interactive user's Credential Manager or DPAPI secrets. A filtered Medium
token is required before any engine process can be started. No password is
accepted by this API or stored by the service.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes as w

from .session_token import Luid, MEDIUM_INTEGRITY, WindowsSessionTokens


MSV1_0_S4U_LOGON = 12
BATCH_LOGON = 4
LUA_TOKEN = 0x4
DISABLE_MAX_PRIVILEGE = 0x1


class AnsiString(ctypes.Structure):
    _fields_ = [("Length", w.USHORT), ("MaximumLength", w.USHORT),
                ("Buffer", ctypes.c_char_p)]


class NativeUnicodeString(ctypes.Structure):
    _fields_ = [("Length", w.USHORT), ("MaximumLength", w.USHORT),
                ("Buffer", ctypes.c_void_p)]


class S4ULogon(ctypes.Structure):
    _fields_ = [("MessageType", w.ULONG), ("Flags", w.ULONG),
                ("UserPrincipalName", NativeUnicodeString),
                ("DomainName", NativeUnicodeString)]


class TokenSource(ctypes.Structure):
    _fields_ = [("SourceName", ctypes.c_char * 8), ("SourceIdentifier", Luid)]


class QuotaLimits(ctypes.Structure):
    _fields_ = [("PagedPoolLimit", ctypes.c_size_t),
                ("NonPagedPoolLimit", ctypes.c_size_t),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("PagefileLimit", ctypes.c_size_t),
                ("TimeLimit", ctypes.c_int64)]


class MandatoryLabel(ctypes.Structure):
    _fields_ = [("Sid", ctypes.c_void_p), ("Attributes", w.DWORD)]


def _ansi(value: bytes) -> tuple[AnsiString, ctypes.Array]:
    buffer = ctypes.create_string_buffer(value)
    return AnsiString(len(value), len(value) + 1,
                      ctypes.cast(buffer, ctypes.c_char_p)), buffer


def s4u_packet(username: str, domain: str = "") -> ctypes.Array:
    """One contiguous request, as required by LsaLogonUser."""
    if not username or "\x00" in username or "\x00" in domain:
        raise ValueError("invalid operator account name")
    user_bytes = username.encode("utf-16-le")
    domain_bytes = domain.encode("utf-16-le")
    if max(len(user_bytes), len(domain_bytes)) > 65534:
        raise ValueError("operator account name is too long")
    size = ctypes.sizeof(S4ULogon) + len(user_bytes) + 2 + len(domain_bytes) + 2
    buffer = ctypes.create_string_buffer(size)
    address = ctypes.addressof(buffer)
    request = ctypes.cast(buffer, ctypes.POINTER(S4ULogon)).contents
    request.MessageType = MSV1_0_S4U_LOGON
    user_at = address + ctypes.sizeof(S4ULogon)
    ctypes.memmove(user_at, user_bytes, len(user_bytes))
    request.UserPrincipalName = NativeUnicodeString(
        len(user_bytes), len(user_bytes) + 2, user_at)
    if domain_bytes:
        domain_at = user_at + len(user_bytes) + 2
        ctypes.memmove(domain_at, domain_bytes, len(domain_bytes))
        request.DomainName = NativeUnicodeString(
            len(domain_bytes), len(domain_bytes) + 2, domain_at)
    return buffer


class S4UIdentity:
    """Own only returned handles; callers close them after engine shutdown."""

    def __init__(self) -> None:
        self.secur = ctypes.WinDLL("secur32", use_last_error=True)
        self.advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.tokens = WindowsSessionTokens()
        self.secur.LsaRegisterLogonProcess.argtypes = [ctypes.POINTER(AnsiString),
                                                        ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.ULONG)]
        self.secur.LsaRegisterLogonProcess.restype = w.LONG
        self.secur.LsaLookupAuthenticationPackage.argtypes = [w.HANDLE,
                                                                ctypes.POINTER(AnsiString),
                                                                ctypes.POINTER(w.ULONG)]
        self.secur.LsaLookupAuthenticationPackage.restype = w.LONG
        self.secur.LsaLogonUser.argtypes = [w.HANDLE, ctypes.POINTER(AnsiString), w.ULONG,
                                            w.ULONG, ctypes.c_void_p, w.ULONG, ctypes.c_void_p,
                                            ctypes.POINTER(TokenSource), ctypes.POINTER(ctypes.c_void_p),
                                            ctypes.POINTER(w.ULONG), ctypes.POINTER(Luid),
                                            ctypes.POINTER(w.HANDLE), ctypes.POINTER(QuotaLimits),
                                            ctypes.POINTER(w.LONG)]
        self.secur.LsaLogonUser.restype = w.LONG
        self.advapi.LsaNtStatusToWinError.argtypes = [w.LONG]
        self.advapi.LsaNtStatusToWinError.restype = w.ULONG
        self.secur.LsaDeregisterLogonProcess.argtypes = [w.HANDLE]
        self.secur.LsaFreeReturnBuffer.argtypes = [ctypes.c_void_p]
        self.advapi.CreateRestrictedToken.argtypes = [w.HANDLE, w.DWORD, w.DWORD,
                                                       ctypes.c_void_p, w.DWORD, ctypes.c_void_p,
                                                       w.DWORD, ctypes.c_void_p, ctypes.POINTER(w.HANDLE)]
        self.advapi.CreateRestrictedToken.restype = w.BOOL
        self.advapi.AllocateLocallyUniqueId.argtypes = [ctypes.POINTER(Luid)]
        self.advapi.ConvertStringSidToSidW.argtypes = [w.LPCWSTR,
                                                       ctypes.POINTER(ctypes.c_void_p)]
        self.advapi.ConvertStringSidToSidW.restype = w.BOOL
        self.advapi.GetLengthSid.argtypes = [ctypes.c_void_p]
        self.advapi.GetLengthSid.restype = w.DWORD
        self.advapi.SetTokenInformation.argtypes = [w.HANDLE, w.DWORD,
                                                    ctypes.c_void_p, w.DWORD]
        self.advapi.SetTokenInformation.restype = w.BOOL
        self.advapi.CheckTokenMembership.argtypes = [w.HANDLE, ctypes.c_void_p,
                                                     ctypes.POINTER(w.BOOL)]
        self.advapi.CheckTokenMembership.restype = w.BOOL
        self.advapi.DuplicateToken.argtypes = [w.HANDLE, ctypes.c_int,
                                              ctypes.POINTER(w.HANDLE)]
        self.advapi.DuplicateToken.restype = w.BOOL

    def _check(self, status: int) -> None:
        if status:
            raise OSError(self.advapi.LsaNtStatusToWinError(status),
                          "Windows S4U logon failed")

    def _sid(self, text: str) -> ctypes.c_void_p:
        sid = ctypes.c_void_p()
        if not self.advapi.ConvertStringSidToSidW(text, ctypes.byref(sid)):
            raise ctypes.WinError(ctypes.get_last_error())
        return sid

    def _restrict_to_medium(self, token: int) -> None:
        medium = self._sid("S-1-16-8192")
        admin = self._sid("S-1-5-32-544")
        try:
            label = MandatoryLabel(medium, 0x20)  # SE_GROUP_INTEGRITY
            size = ctypes.sizeof(label) + self.advapi.GetLengthSid(medium)
            if not self.advapi.SetTokenInformation(w.HANDLE(token), 25,
                                                   ctypes.byref(label), size):
                raise ctypes.WinError(ctypes.get_last_error())
            # CheckTokenMembership rejects a supplied primary token. Duplicate
            # only for this membership check; CreateProcessAsUser retains the
            # verified primary token. SecurityImpersonation = 2.
            impersonation = w.HANDLE()
            if not self.advapi.DuplicateToken(w.HANDLE(token), 2,
                                              ctypes.byref(impersonation)):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                enabled = w.BOOL()
                if not self.advapi.CheckTokenMembership(impersonation, admin,
                                                         ctypes.byref(enabled)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if enabled.value:
                    raise PermissionError("S4U token still has an enabled Administrators group")
            finally:
                self.kernel.CloseHandle(impersonation)
        finally:
            self.kernel.LocalFree(medium)
            self.kernel.LocalFree(admin)

    def logon(self, username: str, domain: str, expected_sid: str) -> int:
        """Return only a filtered, local-file-capable operator batch token."""
        request = s4u_packet(username, domain)
        name, name_buffer = _ansi(b"OrgtreeEngine")
        package, package_buffer = _ansi(b"MICROSOFT_AUTHENTICATION_PACKAGE_V1_0")
        origin, origin_buffer = _ansi(b"OrgtreeBoot")
        # Keep the backing buffers alive across all LSA calls.
        _keep = (name_buffer, package_buffer, origin_buffer)
        lsa = w.HANDLE()
        mode = w.ULONG()
        self._check(self.secur.LsaRegisterLogonProcess(ctypes.byref(name),
                                                        ctypes.byref(lsa), ctypes.byref(mode)))
        raw = w.HANDLE()
        profile = ctypes.c_void_p()
        try:
            package_id = w.ULONG()
            self._check(self.secur.LsaLookupAuthenticationPackage(
                lsa, ctypes.byref(package), ctypes.byref(package_id)))
            source = TokenSource()
            source.SourceName = b"Orgtree"
            if not self.advapi.AllocateLocallyUniqueId(ctypes.byref(source.SourceIdentifier)):
                raise ctypes.WinError(ctypes.get_last_error())
            profile_size = w.ULONG()
            logon_id = Luid()
            quotas = QuotaLimits()
            substatus = w.LONG()
            self._check(self.secur.LsaLogonUser(
                lsa, ctypes.byref(origin), BATCH_LOGON, package_id,
                request, len(request), None, ctypes.byref(source),
                ctypes.byref(profile), ctypes.byref(profile_size),
                ctypes.byref(logon_id), ctypes.byref(raw), ctypes.byref(quotas),
                ctypes.byref(substatus)))
            filtered = w.HANDLE()
            if not self.advapi.CreateRestrictedToken(raw, LUA_TOKEN | DISABLE_MAX_PRIVILEGE,
                                                       0, None, 0, None, 0, None,
                                                       ctypes.byref(filtered)):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                self._restrict_to_medium(int(filtered.value))
                facts = self.tokens.facts(int(filtered.value))
                if (facts.sid != expected_sid or facts.logon_type != BATCH_LOGON
                        or facts.integrity_rid != MEDIUM_INTEGRITY
                        or facts.elevation_type == 2):
                    raise PermissionError("S4U token is not the filtered operator batch identity")
                return int(filtered.value)
            except BaseException:
                self.tokens.close(int(filtered.value))
                raise
        finally:
            if profile.value:
                self.secur.LsaFreeReturnBuffer(profile)
            if raw.value:
                self.tokens.close(int(raw.value))
            self.secur.LsaDeregisterLogonProcess(lsa)
