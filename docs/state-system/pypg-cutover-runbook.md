# Moving Orgtree's data to PostgreSQL: instructions for an outside agent

You are a coding agent running in an ordinary terminal on the user's Windows
PC, **outside** Orgtree. These instructions move the user's Orgtree data from
its current storage (one SQLite database file per organization) into a private
PostgreSQL database that Orgtree then runs on. Follow them in order. Do not
skip a check. When a step tells you to stop, stop: do not improvise a fix,
and do not edit any file in the data folder by hand except where a step says
exactly what to do.

## 1. Words used here

- **Orgtree**: the desktop app. It runs a background program called the
  **engine** (a Python process) that reads and writes the data.
- **Data folder**: `%APPDATA%\Orgtree v2\data` (for example
  `C:\Users\<name>\AppData\Roaming\Orgtree v2\data`). Everything Orgtree
  stores is in it.
- **Organization (org)**: one team inside Orgtree. Each org is stored today
  as one file in `<data folder>\orgs\`, named `<slug>.db` (a SQLite database;
  it may have `<slug>.db-wal` and `<slug>.db-shm` beside it) or, for very old
  orgs, `<slug>.json`. The **slug** is the org's short name.
- **PostgreSQL**: a database server. Here it is a private copy that only
  Orgtree uses, stored in `<data folder>\pg\` and listening only on this PC
  (127.0.0.1).
- **pg-custodian**: a small program (`pg-custodian.exe`) that creates, starts,
  stops and checks that private PostgreSQL. It refuses to work on any folder
  it has not been told is safe.
- **pgimport**: the Python script `tools\pypg\pgimport.py` that copies the
  orgs into PostgreSQL and then switches Orgtree over.
- **Dry run**: pgimport reading every org and reporting counts, checksums and
  problems, without writing anything.
- **Manifest / checksum**: for each org, pgimport counts the rows of every
  kind of data and computes a SHA-256 checksum of them. `manifest_sha256` is
  one checksum over all of that. The same data always gives the same value, so
  matching values before and after the copy mean the copy is exact.
- **Cutover record**: the file `<data folder>\store-backend.json`. When it
  says `"backend": "postgres"`, Orgtree uses PostgreSQL. When it is absent,
  Orgtree uses the old SQLite files.
- **Product binding**: the file `<data folder>\orgtree-product-root.json`,
  written by the `prepare` step. It tells pg-custodian that this data folder
  is Orgtree's real one and may be served.
- **Rollback folder**: `<data folder>\pre-postgres\orgs\`. At cutover the old
  org files are moved here unchanged, so they can be put back.
- **Marker file**: `<data folder>\orgs\<slug>.pg`, a small file saying this
  org now lives in PostgreSQL.
- **Event log**: the Windows Application event log. When Orgtree refuses to
  start on PostgreSQL it writes one line there, source `Orgtree P03`.

## 2. Load the installed app's paths

The v3 package includes Python, its binary psycopg driver, PostgreSQL 18.6,
pg-custodian and pgimport. No source checkout or separate PostgreSQL install
is needed. On launch the desktop writes `%APPDATA%\Orgtree v2\engine-paths.json`
with its actual installation and selected data paths. Launch the approved v3
build once before doing this cutover; existing stores remain on their current
backend. A genuinely fresh install already starts on PostgreSQL and does not
need this migration.

Open **PowerShell from the Start menu**, outside Orgtree, and run:

```powershell
$paths = Get-Content "$env:APPDATA\Orgtree v2\engine-paths.json" -Raw -ErrorAction Stop | ConvertFrom-Json
if ($paths.schema -ne 'orgtree.engine-paths/v1') { throw 'Unexpected engine path descriptor' }
foreach ($file in @($paths.python, $paths.custodian, $paths.importer, (Join-Path $paths.pgBin 'postgres.exe'))) {
  if (-not [IO.Path]::IsPathRooted($file) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing installed file: $file" }
}
if (-not [IO.Path]::IsPathRooted($paths.data)) { throw 'Invalid data path' }
$env:PY = $paths.python
$env:PG = $paths.custodian
$env:PGBIN = $paths.pgBin
$env:DATA = $paths.data
$env:IMPORTER = $paths.importer
$env:RESOURCES = Split-Path $paths.engine
cmd.exe
```

Keep this terminal for the commands below. These variables affect this
terminal only; no `setx` or registry changes are needed. If the descriptor or a
file is missing, stop and ask the team to verify the installed build. Do not
substitute another Python or custodian. For a separate Dev installation, use
its own user-data descriptor rather than this production one.

## 3. Things that must be in place first

Check each one. If one fails, stop at this point: nothing has changed yet.

1. **The installed Orgtree must be a build that can run on PostgreSQL.**
   It must include the PG-0, PG-1, PG-2 and bundled-runtime work. Ask the team
   for the approved build's version and confirm it before continuing.
2. **psycopg** (the Python library that talks to PostgreSQL) must be
   importable by `PY`, which is the installed app's own Python. Check it:

   ```bat
   "%PY%" -c "import psycopg; print(psycopg.__version__, psycopg.__file__, psycopg.pq.__impl__)"
   ```

   Expected: a version (3.x), a path under the installed runtime, and `binary`.
   `ModuleNotFoundError` or another implementation means stop.
3. **pg-custodian.exe and the PostgreSQL binaries** exist at `PG` and
   `PGBIN` inside the installed package.

   ```bat
   dir "%PG%"
   dir "%PGBIN%\postgres.exe"
   ```

4. **The packaged desktop supplies both executable paths automatically.**
   Backend selection and connection details belong to the engine. Do not set
   `ORGTREE_STORE` or `ORGTREE_PG_CONNINFO` globally.
5. **Enough free disk** for a full copy of `DATA` (step 5 makes one).

## 4. Stop Orgtree completely

1. Quit Orgtree from its window and from the tray icon (right-click it, then
   Quit).
2. Confirm nothing from Orgtree is still running. In PowerShell:

   ```powershell
   Get-CimInstance Win32_Process | Where-Object {
     $_.ExecutablePath -like '*\Orgtree\*' -or $_.CommandLine -like '*Orgtree v2*' -or $_.Name -eq 'postgres.exe'
   } | Select-Object ProcessId, Name, CommandLine | Format-List
   ```

   Expected: nothing. That covers the app, its engine, any agents it
   started, and any PostgreSQL. If something is listed, wait a minute and
   run it again. If it is still there, ask the user to close it. Do not kill
   processes yourself unless the user says so.

pgimport checks this again itself. It takes the data folder's lock file
(`DATA\.owner`), which a running engine holds, and refuses with
`is in use (its owner lock is held): stop the engine first`.

## 5. Back up the data folder

```bat
robocopy "%DATA%" "%DATA%-backup-pre-postgres" /E /COPY:DAT /R:0 /W:0
```

Expected: robocopy's exit code is 0 or 1 (it uses 0-7 for success), with 0
files `FAILED` in its summary. Keep this copy until the user says it can go.

## 6. Open a clean terminal

Use the terminal from section 2, which was opened outside Orgtree. If it was
closed, repeat section 2 to load the recorded paths. Then run:

```bat
set "ORGTREE_DATA=%DATA%"
set ORGTREE_AGENT_PARENT_DATA=
set ORGTREE_AGENT_LEGACY_DATA=
set ORGTREE_STORE=
set ORGTREE_PG_BOOTSTRAP=
set ORGTREE_PG_CONNINFO=
set ORGTREE_PG_URL=
set "ORGTREE_P03_PG_BIN=%PGBIN%"
cd /d "%RESOURCES%"
```

`set NAME=` with nothing after the `=` removes that variable. The two
`ORGTREE_AGENT_*` variables exist only inside Orgtree's own agents. If they
are set, both pgimport and pg-custodian refuse on purpose.

## 7. Dry run (reads only, changes nothing)

```bat
"%PY%" "%IMPORTER%" dry-run --root "%DATA%" --out "%USERPROFILE%\pgimport-dry-run.json"
echo exit=%ERRORLEVEL%
```

Expected: `exit=0`. The terminal also shows a line like
`pgimport dry-run: {"orgs": 12, "importable": true, "refused": 0}`.

Check the report `%USERPROFILE%\pgimport-dry-run.json`:
- `"importable": true` and `"refused": []`.
- `"orgs"` has one entry per org file in `DATA\orgs\`. Each entry has
  `manifest_sha256` and a `manifest` with row counts.
- `provenance.store` is inside `%RESOURCES%\engine\backend\`, the same
  installed package as `PY` and `IMPORTER`. Any other checkout or installation
  means the wrong code was loaded: stop.

`exit=3` means **refused**. Nothing was written. The `refused` list says which
org and why. See section 12, "Refused unknown data". Stop here.

## 8. Prepare (writes the product binding)

```bat
"%PY%" "%IMPORTER%" prepare --root "%DATA%" --custodian "%PG%"
echo exit=%ERRORLEVEL%
```

Expected: `exit=0`, and `DATA\orgtree-product-root.json` now exists. This
step changes nothing else. `exit=3` prints
`pg-custodian bind-product refused: <code>: <message>` (see section 12, "The
guard refuses").

## 9. Import and cut over

```bat
"%PY%" "%IMPORTER%" import --root "%DATA%" --custodian "%PG%" --cutover --out "%USERPROFILE%\pgimport-import.json"
echo exit=%ERRORLEVEL%
```

It does these, in order:
1. Takes the lock, so Orgtree cannot start during the import.
2. Creates the private PostgreSQL in `DATA\pg\` (first run only) and starts
   it.
3. Creates the database tables.
4. Copies each org in one transaction, reads it back, and compares it byte
   for byte.
5. Writes `DATA\orgs\<slug>.pg`.
6. Writes the cutover record `DATA\store-backend.json`.
7. Moves every other file in `DATA\orgs\` to `DATA\pre-postgres\orgs\`,
   unchanged.
8. Stops PostgreSQL.

The first run can take several minutes.

Expected: `exit=0`, plus a line
`pgimport import: {"orgs": N, "cutover": true}`.

If it stops part-way (closed window, crash, power loss), run the **same
command again**. Orgs already copied with an identical checksum are skipped. A
cutover that wrote its record but did not finish moving files is finished;
that re-run prints `{"cutover_completed": true, "moved": K}`.

No persistent environment changes follow the import. On the next launch the
desktop supplies the bundled paths, and the engine reads the cutover record.

## 10. Success checks (before starting Orgtree)

All of these must hold. If one does not, go to section 13 (abort).

1. **The checksums match.** In PowerShell:

   ```powershell
   $d = Get-Content "$env:USERPROFILE\pgimport-dry-run.json" -Raw | ConvertFrom-Json
   $i = Get-Content "$env:USERPROFILE\pgimport-import.json" -Raw | ConvertFrom-Json
   foreach ($s in $d.orgs.PSObject.Properties.Name) {
     "{0}  dry={1}  imported={2}  same={3}" -f $s, $d.orgs.$s.manifest_sha256, $i.orgs.$s.manifest_sha256, ($d.orgs.$s.manifest_sha256 -eq $i.orgs.$s.manifest_sha256)
   }
   ```

   Expected: one line per org, every one `same=True`. Each org's `action` in
   the import report is `imported` (or `already_imported` on a re-run).
2. **The cutover record exists:** `type "%DATA%\store-backend.json"` shows
   `"backend": "postgres"`, the per-org checksums, and `"moved_to":
   "pre-postgres/orgs"`.
3. **`DATA\orgs\` holds only marker files:** `dir /b "%DATA%\orgs"` lists only
   `<slug>.pg` files, one per org.
4. **The old files are still present, unchanged:**
   `dir /b "%DATA%\pre-postgres\orgs"` lists every `.db` / `.db-wal` /
   `.db-shm` / `.json` file that used to be in `orgs\`. Their sizes equal the
   copies in the step 5 backup.
5. **PostgreSQL is stopped again:**
   `"%PG%" status --root "%DATA%" --product` prints JSON with `"ok": true` and
   `"cluster": { "state": "stopped", ... }`. pg-custodian always prints JSON:
   `"ok": false` with a `code` and a `message` means it refused.

## 11. Start Orgtree and check it

1. Start Orgtree from the Start menu.
2. **Orgtree is running on PostgreSQL.** Within a minute or two of start:

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | Select-Object ProcessId, CommandLine
   ```

   Expected: postgres processes whose command line contains
   `Orgtree v2\data\pg` (the path may be written with `/`).
3. **No refusal was logged:**

   ```powershell
   Get-EventLog -LogName Application -Source 'Orgtree P03' -Newest 5 -ErrorAction SilentlyContinue | Format-List TimeGenerated, EntryType, Message
   ```

   Expected: nothing newer than the moment you started Orgtree. An `Error`
   entry is a refusal: its message is JSON naming the reason. Windows may put
   a "description cannot be found" note in front of it; that is normal.
4. **The data is visible.** Ask the user to confirm:
   - the org list shows every org from the dry-run report;
   - a work item and a recent mail they know well are there, as before;
   - they can make one small harmless change (for example, a docket note)
     and it is still there after restarting Orgtree.

If all of this holds, the cutover is done. Give the user the two report files,
and tell them the backup from step 5 is still in place.

## 12. Troubleshooting

In every case, copy the **exact** error text into your report (see section
14).

**Refused unknown data (dry run exit 3).** pgimport only copies data it fully
recognizes. It refuses rather than guess, by design. Typical messages:
- `unrecognised file` or `unexpected folder` in `orgs\`;
- an unknown table, column, document key or log section;
- a NUL character, or JSON that is not strict (for example `NaN`);
- `a .json beside <slug>.db (which one is the authority?)`;
- `an interrupted JSON->SQLite migration (start the SQLite engine once to finish it)`.

Nothing was changed. Do not delete or edit data to get past it. For the
interrupted migration only: start Orgtree once normally (it is still on
SQLite), quit it, and run the dry run again. For everything else: stop, and
send the report.

**Checksum or count mismatch.** For example `read-back does not match the
source in ...`, `read-back is not byte-identical ...`, or
`cutover refused: imported manifests differ from the dry run`. The copy in
PostgreSQL differs from the original, so pgimport refused to cut over. The old
files are untouched and `store-backend.json` was not written. Stop and send
everything. Do not re-run repeatedly.

**`is in use (its owner lock is held): stop the engine first`.** Orgtree or
its engine is still running. Go back to section 4.

**Port in use** (`port.occupied`) **or** `port.pick`. PostgreSQL could not get
a network port on 127.0.0.1. Normally it picks a free one itself. Check that
no other `postgres.exe` from a previous attempt is running (section 4 command)
and try again once. If it repeats, stop and send the error.

**psycopg missing** (`ModuleNotFoundError: No module named 'psycopg'`, or
`orgtree.pgstore (PG-0) is not importable`). The Python used has no psycopg.
If it came from pgimport, the `PY` you were given is wrong: stop and ask. If
Orgtree refused with it after cutover, the installed build lacks psycopg:
abort (section 13).

**The guard refuses.** pg-custodian or Orgtree refuses to serve the folder.
The codes are:
- `product.not_engine_root`: `ORGTREE_DATA` is not set to exactly `DATA`.
  Redo section 6.
- `root.protected`: the folder overlaps a protected place (an agent's data
  or the install folder), or an `ORGTREE_AGENT_*` variable is set. Redo
  section 6 in a fresh terminal from the Start menu.
- `product.refused`: a pg-custodian command that is never allowed on the real
  data folder (for example `destroy` or `restore`). Nothing in this document
  runs one. If you see it, report which command printed it.
- `product.unbound` or `... has no product binding`: `prepare` was not run.
  Run step 8.
- `Desktop agent development storage requires an explicit independent
  ORGTREE_DATA`: you are inside an Orgtree agent session. This work cannot be
  done from there, by design. Use a plain terminal.
- `root.reparse_point`: `DATA` or `DATA\pg` is a link or junction. Stop and
  report it. Do not change it.

Do not try to get around a guard. They exist to protect the user's data.

**`the cutover of ... to PostgreSQL did not finish: orgs/ still holds ...`**
(Orgtree refuses at start). Step 9 stopped between writing the record and
moving the files. Quit Orgtree, run the step 9 import command again (it only
moves the remaining files), and start Orgtree again. Or abort (section 13).

**`ORGTREE_STORE=postgres needs ORGTREE_PG_CUSTODIAN`** or
**`ORGTREE_PG_CUSTODIAN=... is not an existing absolute file`** (Orgtree
refuses at start; the text is in the event log). The installed build has
missing runtime wiring or a missing payload file. Quit completely (section 4),
retain the descriptor and exact error, and ask the team to verify the build.
Do not point the app at another PostgreSQL installation to repair it.

**Orgtree does not come up after cutover, or shows a white window.** Look in
the event log (step 11.3). It does not fall back to SQLite by itself, by
design. Abort (section 13).

**Any other error** (a Python traceback, exit code 1 or 2). Stop and send it.

## 13. Abort: go back to the old storage

Stop when any of these happens:
- a check in section 3, 10 or 11 fails;
- a checksum or count mismatch appears;
- the same error comes back after the one retry this document allows;
- Orgtree will not start on PostgreSQL, or data looks missing or wrong.

To put SQLite back in charge:

1. Quit Orgtree and confirm nothing is running (section 4).
2. If `DATA\store-backend.json` exists, rename it:
   `ren "%DATA%\store-backend.json" store-backend.json.aborted`.
   Keep Orgtree stopped until the source files and explicit SQLite selection
   below are restored.
3. If `DATA\pre-postgres\orgs\` holds files, move them back:

   ```bat
   move "%DATA%\pre-postgres\orgs\*" "%DATA%\orgs\"
   ```

4. Move the marker files out of the way:
   `mkdir "%DATA%\pre-postgres\markers"` then
   `move "%DATA%\orgs\*.pg" "%DATA%\pre-postgres\markers\"`.
5. Check: `dir /b "%DATA%\orgs"` shows the `.db` (and any `.json`) files again
   and no `.pg`, and `store-backend.json` is gone.
6. Record the rollback explicitly, including when the original store had no
   orgs. This prevents the fresh-install logic from treating the leftover
   PostgreSQL folder as unexplained data:

   ```bat
   "%PY%" -c "import json,os,pathlib; p=pathlib.Path(os.environ['DATA'])/'store-backend.json'; t=p.with_suffix('.json.tmp'); t.write_text(json.dumps({'schema':'orgtree.store-backend/v1','backend':'sqlite','via':'external-rollback'}),encoding='utf-8'); os.replace(t,p)"
   ```

   Expected: `type "%DATA%\store-backend.json"` names `sqlite`. No user
   environment variables were created by this runbook, so none need deleting.
7. Start Orgtree. It runs on SQLite. Ask the user to confirm the orgs look as
   before.

Leave `DATA\pg\` and `DATA\orgtree-product-root.json` alone. The explicit
SQLite record keeps them inactive; the team may want to examine them.

Anything written in Orgtree **after** it switched to PostgreSQL exists only in
PostgreSQL, and going back loses it. This is accepted. If steps 1-7 fail or
the data still looks wrong, restore the step 5 backup:
1. With Orgtree stopped, rename `DATA` to `data-failed-<date>`.
2. Copy `%DATA%-backup-pre-postgres` back to the original data path.
3. Start Orgtree.

## 14. What to send back

Put these in one folder and give it to the user for the Orgtree team:
- `%USERPROFILE%\pgimport-dry-run.json` and
  `%USERPROFILE%\pgimport-import.json` (whichever exist);
- the full terminal output of every pgimport and pg-custodian command, with
  its exit code;
- the exact text of every error;
- the output of `dir /s /b "%DATA%\orgs" "%DATA%\pre-postgres"` and
  `type "%DATA%\store-backend.json"` (if it exists);
- `"%PG%" status --root "%DATA%" --product` output;
- the event log lines from step 11.3, and any Orgtree crash reports in
  `%APPDATA%\Orgtree v2\Crashpad\reports\`;
- the Orgtree version and installed commit from
  `%RESOURCES%\build-info.json`, plus the `engine-paths.json` descriptor;
- which step you stopped at, and whether you aborted.

Do not send the contents of `DATA\pg\` or any `.db` file unless asked. They
hold the user's private data.
