# Synthetic upgrade fixtures

These files contain only invented data. Each release has two orgs, `alpha` and
`beta`, saved and loaded by the engine at its published git tag. The 2.1.14
fixtures are standalone SQLite backups. The 3.0.9 and 3.1.0 fixtures are plain
SQL dumps of fresh throwaway databases at migration levels 0019 and 0020.
The `.pg` files are their original org markers.

`manifest.json` records the resolved tag commit, the release store's file
checksum, each document section's entry count and canonical JSON SHA256, and
the fixture files' SHA256. Text file checksums normalize CRLF to LF; SQLite
checksums use the exact bytes. Document checksums use Python's
`json.dumps(value, sort_keys=True, ensure_ascii=False)` encoded as UTF-8.

The generator supplies the current section registry as synthetic input, so
every registered section is present, including keys that older releases kept
without using. The release's own `Org`, `save_org` and `load_org` write and read
that input. An exported tag's imports are checked against its export directory;
its resolved git commit and writer checksum provide the source identity.

## Regenerate

Fetch the named tags first. Use existing PostgreSQL binaries and an existing
custodian executable; these commands build and install nothing. From the repo
worktree, run in PowerShell (replace the two executable paths as needed):

```powershell
& tools/p03-run.ps1 -Agent upgrade-sol -Wait -Purpose 'Regenerate upgrade fixtures' -Run @(
  'python', '-I', 'tools/run-upgrade-path-checks.py', '--generate-only',
  '--custodian', 'E:\Libraries\Desktop\orgtree\artifacts\p03-tools\pg-custodian-e4f3c8f.exe',
  '--pg-bin', 'E:\Libraries\Desktop\orgtree\artifacts\p03-postgresql\18.6-4\bin')
python -I tools/capture-published-migrations.py
```

The launcher provisions and stops its own temporary cluster. The generator
exports `v2.1.14`, `v3.0.9` and `v3.1.0` with `git archive`, runs each tag's
store in an isolated child, backs up SQLite with its backup API, and dumps
PostgreSQL with `pg_dump`. It never reads a user's org. Timestamps, identities
and dump restriction tokens can change on regeneration; review the new
manifests and files together.

## Verify

Use the same P03 command with `--json-output <receipt.json>` in place of
`--generate-only`. It runs `tools/run-python-verification.py` on
`tests/test_upgrade_paths_pg.py` and `tests/test_published_migrations.py`.
The heavy lock and normal memory gates apply, including during regeneration.

The SQLite path uses the landed import-held CLI (`PgSink`, the same first-launch
import implementation), then the converter CLI. The PostgreSQL paths restore
the tag dumps without running any migration on them. Each path compares the
conversion's section counts and checksums with the committed manifest, checks
actual destination fields with `tools/orgdb_verify.py`, and checks every legacy
table and source file remains unchanged. Each path plants a duplicate docket
slug in beta, checks beta is unavailable while alpha converts, removes the
fault, and retries beta. A count-preserving destination corruption must fail
the independent verifier on each successful path.

`published-migrations.json` is captured directly from all eleven published
3.x tags. The checksum tests require the checkout's legacy files 0001-0020 to
match those published bytes, and require every 3.0.0-3.0.9 migration set to be
identical. Future migrations may be added without changing these checksums.
