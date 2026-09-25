# prototype-guard dependencies

| Crate | Version | Licence | Purpose |
|---|---|---|---|
| `serde` (+ `serde_derive`) | 1.0.228 | MIT OR Apache-2.0 | Derive the prototype-root marker record. |
| `serde_json` | 1.0.150 | MIT OR Apache-2.0 | Parse the marker strictly (`deny_unknown_fields`). |

Both are the exact versions every P03 crate locks (M1 contract §2 row 1b).
Nothing else: canonicalization and the reparse-point scan use `std` only.
