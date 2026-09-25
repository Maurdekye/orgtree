# Cutting a real data root over to PostgreSQL (PG-2 runbook)

This moves one Orgtree data root from its SQLite/JSON files to the root's own
private PostgreSQL database. It uses `tools/pypg/pgimport.py` (PG-2) and the
`pg-custodian` executable (PG-1 / WS1).

**Who runs it.** Only coordinator-opus decides when the REAL root is cut over
(plan decision P4 / 33), and the user runs it by hand in a plain terminal.
No agent can run it, on purpose: inside an agent session `devguard` refuses to
import `store` against the live root, and `pg-custodian bind-product` refuses
while `ORGTREE_AGENT_PARENT_DATA` or `ORGTREE_AGENT_LEGACY_DATA` overlaps the
root. Do not work around either guard.

**What was tested.** The whole sequence below (dry-run, prepare, import
`--cutover`, engine start on PostgreSQL, a half-finished cutover finished by
a re-run, destroy refused on a product root) passes in
`tests/pgimport_drill.py` on throwaway roots. The real root
(`%APPDATA%\Orgtree v2\data`) has never been run through it; that it behaves
the same is inferred, not measured.

## 0. Prerequisites

- A checkout of the landed commit that contains PG-0, PG-1 and PG-2
  (`<REPO>` below), with its engine runtime at `<REPO>\engine\runtime`.
- psycopg 3 importable by that runtime (the coordinator's packaging step).
  Check: `"<REPO>\engine\runtime\python.exe" -c "import psycopg; print(psycopg.__version__, psycopg.__file__)"`.
  The engine needs it too once it runs on PostgreSQL.
- A built `pg-custodian.exe` at an absolute path (`<CUSTODIAN>`), and the
  PostgreSQL 18.6-4 binaries (`<PGBIN>`, the folder holding `postgres.exe`).
- Enough free disk for a full copy of the root (the backup in step 1).

## 1. Stop Orgtree and back up

1. Quit the Orgtree app completely (including the tray). The import takes the
   root's owner lock and refuses while an engine holds it, so a running app is
   caught, not raced.
2. Copy the whole root while it is stopped:
   `robocopy "%APPDATA%\Orgtree v2\data" "%APPDATA%\Orgtree v2\data-backup-pre-postgres" /E /COPY:DAT`

## 2. Open a plain terminal

Open `cmd.exe` from the Start menu (not from Orgtree, not from an agent), then:

```bat
set ORGTREE_DATA=%APPDATA%\Orgtree v2\data
set ORGTREE_AGENT_PARENT_DATA=
set ORGTREE_AGENT_LEGACY_DATA=
set ORGTREE_P03_PG_BIN=<PGBIN>
set PY=<REPO>\engine\runtime\python.exe
set PG=<CUSTODIAN>
cd /d <REPO>
```

(`set NAME=` with nothing after it removes the variable in cmd.)

## 3. Dry run (reads only)

```bat
"%PY%" tools\pypg\pgimport.py dry-run --root "%ORGTREE_DATA%" --out "%USERPROFILE%\pgimport-dry-run.json"
```

- Exit 0 = importable. Exit 3 = refused: nothing is written, and the report's
  `refused` list names every org and reason (an unknown table, column,
  document key or log section, a NUL, non-strict JSON). Refusals are strict by
  ruling (R4); stop here and send the report to the coordinator.
- Check `provenance.store` in the report points into `<REPO>\engine\backend`,
  not into the installed app.

## 4. Prepare (bind the root for product mode)

```bat
"%PY%" tools\pypg\pgimport.py prepare --root "%ORGTREE_DATA%" --custodian "%PG%"
```

This writes `orgtree-product-root.json` in the root. It refuses unless the
root equals `ORGTREE_DATA`, no agent variable is set, and the root is not in an
install folder.

## 5. Import and cut over

```bat
"%PY%" tools\pypg\pgimport.py import --root "%ORGTREE_DATA%" --custodian "%PG%" --cutover --out "%USERPROFILE%\pgimport-import.json"
```

It starts the root's database (under `<root>\pg\`), runs the PG-0 migrations,
imports each org in one transaction, reads it back byte for byte, writes
`orgs\<slug>.pg`, then writes `store-backend.json` (`backend: postgres`) and
moves every other file in `orgs\` to `pre-postgres\orgs\` unchanged. It stops
the database again at the end. Exit 0 = done, 3 = refused (read the message).

If it is interrupted, run the same command again: orgs already imported with
the same manifest are skipped, and a cutover that wrote its record but did not
finish moving files is finished (it only moves the remaining files).

## 6. Post-checks

1. Every `orgs.<slug>.manifest_sha256` in `pgimport-import.json` equals the
   same field in `pgimport-dry-run.json`.
2. `type "%ORGTREE_DATA%\store-backend.json"` shows `"backend": "postgres"`.
3. `dir "%ORGTREE_DATA%\orgs"` lists only `*.pg` files;
   `dir "%ORGTREE_DATA%\pre-postgres\orgs"` lists the original files.
4. `"%PG%" status --root "%ORGTREE_DATA%" --product` reports the cluster
   stopped.
5. Start Orgtree with `ORGTREE_PG_CUSTODIAN=<CUSTODIAN>` and
   `ORGTREE_P03_PG_BIN=<PGBIN>` in its environment (how the app gets them is
   the packaging step). Open each org and compare it with what it showed
   before. If the engine refuses, it does not fall back to SQLite: it raises
   and writes one line to the Windows Application event log (source
   `Orgtree P03`, component `p03_bracket`). Read it with
   `powershell -c "Get-EventLog -LogName Application -Source 'Orgtree P03' -Newest 5 | Format-List"`.

## 7. Rollback

With Orgtree stopped:

1. Move every file from `%ORGTREE_DATA%\pre-postgres\orgs\` back into
   `%ORGTREE_DATA%\orgs\`.
2. Delete `%ORGTREE_DATA%\store-backend.json` and the `orgs\*.pg` files.
3. Start Orgtree; it runs on SQLite again.

Anything written after the switch exists only in PostgreSQL and is lost by a
rollback (accepted, decision 30 (4)). The `pg\` folder and
`orgtree-product-root.json` can stay; they do nothing without the record. If
the rollback itself goes wrong, restore the backup from step 1.
