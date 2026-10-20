# Standing-instruction wording fixtures

`seat-A.txt` and `seat-B.txt` are the complete, approved synthetic examples
from the 2026-10-20 proposal (user approval 20:03Z), not snapshots regenerated
from the implementation under test. UTF-8/LF lengths are 10,389 and 10,401 bytes.
The baseline at `3dc709564f7fb70e839d0a6a33606815facd9c03` rendered 11,649 and
11,661 bytes. Both fixtures use fake identities, paths and charters.

`legacy-3dc7095.json` records the baseline renderer's UTF-8 byte lengths and
SHA-256 fingerprints for 20 no-skills profiles. It protects legacy wording,
notes, paths and lane-specific behavior from accidental edits to shared text.
The matrix covers five lanes, top-level/subordinate seats and writable/
read-only scopes. Trimmed counterparts bring the render evidence to 40 profiles.

The tests in `runtime/identity/compression_tests.rs` use the real identity
builder without starting an engine, reading live data or opening a database.
Set `ORGTREE_IDENTITY_RENDER_DIR` to a disposable output directory and run the
`export_compression_profiles` test with `--nocapture` to obtain `profiles.json`
and the two example renders. Exact wording changes require an intentional
fixture update; byte-only changes are not evidence that a rule was preserved.

See [INSTRUCTIONS-TRIM](../../../../../docs/skills/INSTRUCTIONS-TRIM.md#14-approved-wording-compression-2026-10-20)
for the approved scope and the separate tool-description caps.
