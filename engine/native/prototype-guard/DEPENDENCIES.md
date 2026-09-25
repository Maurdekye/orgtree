# prototype-guard dependencies

| Crate | Version | Licence | Purpose |
|---|---|---|---|
| `serde` (+ `serde_derive`) | 1.0.228 | MIT OR Apache-2.0 | Derive the prototype-root marker record. |
| `serde_json` | 1.0.150 | MIT OR Apache-2.0 | Parse the marker strictly (`deny_unknown_fields`). |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 | Win32 declarations (Microsoft) for the owner-only ACL module: SDDL security descriptors at creation, `GetNamedSecurityInfoW` read-back, the current user's SID. Windows only. |

All are the exact versions every P03 crate locks (M1 contract §2 row 1b).
Canonicalization and the reparse-point scan use `std` only.
