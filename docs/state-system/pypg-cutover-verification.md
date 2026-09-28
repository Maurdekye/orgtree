# Verifying Orgtree v3's data conversion: a procedure for an outside agent

You are a coding agent in an ordinary terminal on the user's Windows PC,
**outside** Orgtree. You did not take part in the upgrade. Orgtree v3 has
converted the user's data from SQLite to PostgreSQL on its first start (see
[the upgrade guide](pypg-cutover-runbook.md), which defines every term used
here). Your job is to check, independently, that nothing was lost or changed,
and to report. **You only read.** Do not edit, move or delete anything in the
data folder or the backup, and do not start Orgtree while you work.

What you compare:
- **Before**: the backup the user made before installing v3,
  `%APPDATA%\Orgtree v2 backup before v3\data`.
- **After**: the live data folder, `%APPDATA%\Orgtree v2\data`, with its
  PostgreSQL database in `data\pg\`.

If there is no backup, stop: the full check needs one. The upgrade guide's
quick check (its section 5) is then the only check available.

## 1. Stop Orgtree

Ask the user to quit Orgtree (window and tray icon). Then, in PowerShell:

```powershell
Get-ScheduledTask -TaskName 'Orgtree Background Engine' -ErrorAction SilentlyContinue | Stop-ScheduledTask
Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -like '*\Orgtree\*' -or $_.CommandLine -like '*Orgtree v2*' -or $_.Name -eq 'postgres.exe'
} | Select-Object ProcessId, Name, CommandLine | Format-List
```

Expected: nothing listed. If something is, wait a minute and look again; if
it stays, ask the user. Do not kill processes yourself.

## 2. Load the installed app's paths

Everything below uses the installed app's own Python and PostgreSQL, never a
developer checkout or another installation. Keep this PowerShell window open
for the rest of the procedure:

```powershell
$guid = '{21991930-a33d-57f0-b948-692a56fc3ca7}'   # Orgtree's installer id
$install = @('HKCU:', 'HKLM:') | ForEach-Object {
  (Get-ItemProperty "$_\Software\$guid" -ErrorAction SilentlyContinue).InstallLocation } |
  Where-Object { $_ } | Select-Object -First 1
if (-not $install) { throw 'The Orgtree install folder is not recorded in the registry' }
$res = Join-Path $install 'resources'
$PY = Join-Path $res 'engine\runtime\python.exe'
$PG = Join-Path $res 'engine\pg-custodian.exe'
$PGBIN = Join-Path $res 'engine\postgresql\bin'
$VERIFY = Join-Path $res 'tools\pypg\cutover_verify.py'
$DATA = Join-Path $env:APPDATA 'Orgtree v2\data'
$BACKUP = Join-Path $env:APPDATA 'Orgtree v2 backup before v3\data'
foreach ($f in $PY, $PG, (Join-Path $PGBIN 'psql.exe')) {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "Missing installed file: $f" } }
foreach ($d in $DATA, $BACKUP) { if (-not (Test-Path -LiteralPath $d -PathType Container)) { throw "Missing folder: $d" } }
# Only this window: the private database accepts the data folder only when
# ORGTREE_DATA names it, and refuses when an agent session's variables are set.
$env:ORGTREE_DATA = $DATA
$env:ORGTREE_P03_PG_BIN = $PGBIN
foreach ($v in 'ORGTREE_AGENT_PARENT_DATA', 'ORGTREE_AGENT_LEGACY_DATA', 'ORGTREE_STORE',
               'ORGTREE_PG_CONNINFO', 'ORGTREE_PG_BOOTSTRAP', 'PYTHONPATH', 'PYTHONHOME') {
  Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
Get-Content (Join-Path $res 'build-info.json')
```

Record the version and commit that `build-info.json` prints.

If `tools\pypg\cutover_verify.py` is missing from the install, get
`tools/pypg/cutover_verify.py` from the Orgtree repository at that commit,
save it anywhere outside the data folder, and set `$VERIFY` to its path. It
needs nothing else. It uses only Python's standard library, the installed
psycopg driver, and `pg-custodian.exe` to start and stop the private
database. It does not use the code that performed the conversion.

## 3. Run the full comparison

```powershell
& $PY $VERIFY --backup $BACKUP --data $DATA --custodian $PG --out "$env:USERPROFILE\orgtree-verify.json" --after-launch
"exit=$LASTEXITCODE"
```

`--after-launch` is required: v3 has already run on the converted data, so
new mail, turns and settings written since then are expected. It can take a
few minutes on a large data folder (it reads every file of both folders).

**What it checks.**
1. **Files.** Every file in the backup must still exist. The org files from
   `orgs\` must be in `pre-postgres\orgs\`, byte for byte (by SHA-256). No
   attachment (`...\uploads\`, `...\outbox\`) may be missing or changed.
   Other files that v3 changed or added since its first start (transcripts,
   logs, settings) are listed as `changed_since_backup`, not as problems.
2. **Database.** For every org in the backup's `orgs\`, the org must be in
   PostgreSQL, and:
   - every agent in the backup is still there;
   - every history row in the backup (mail history, turn history, event
     logs) is still there, unchanged, under the same sequence number. One
     removal is expected: every start sends each live agent a restart notice
     that keeps only that agent's newest 100 mail-history entries, so an
     agent that already had 100 loses its oldest ones. Those are listed under
     `changed_since_backup` ("oldest mail-archive row(s) trimmed by the
     engine's restart notice"), not as problems, and only when the agent
     still has at least 100 entries, every missing one is older than all
     of them, at most 99 of its entries come from the backup (the 100 kept
     include the new notice), and it has at least one entry the backup did
     not have. Limit: entries that arrived after the backup and were trimmed
     again cannot be seen, so a fault that removed a few extra of the oldest
     entries on top of such a trim would not be caught;
   - every ticket that was open in the backup is still open, or has since
     been archived.

   Counts are printed for both sides. The script also shows a few named
   records from both sides (first, middle and last agent and ticket; the last
   few mails) for you to compare by eye.

**PASS looks like this**: `exit=0`, and the last line reads
`VERDICT: PASS (0 problem(s)); report: ...`. Above it, one line per org:

```
org orgtree: agents 1071/1071, open_work_items 108/108, archived_work_items .../..., mail_log .../..., ...  (backup/PostgreSQL)
```

After launch, the PostgreSQL number may be **larger** than the backup's
(new agents, mail, tickets). It must never be smaller, except open tickets
that were archived. In that case, archived tickets grow by the same amount.

**FAIL**: `exit=1`, with one `PROBLEM:` line per difference. **CANNOT RUN**:
`exit=2`, with the reason (for example, the database would not start). Both
go into the report. Do not try to repair anything.

The JSON report (`orgtree-verify.json`) holds all of it: `files.problems`,
`database.orgs.<slug>.counts`, `.samples` and `.changed_since_backup`, the
tool's own SHA-256 (`tool_sha256`), and the Python it ran with.

## 4. Independent spot checks (without the script)

These cross-check the script's counts by hand. They use only `psql.exe` and
the installed Python, reading both sides.

**Start the private database** (only if the script left it stopped, which it
does). The output goes to files because a started PostgreSQL keeps its
output handles open:

```powershell
cmd /c "`"$PG`" start --root `"$DATA`" --product > `"$env:TEMP\pg-start.json`" 2>&1"
cmd /c "`"$PG`" attach --root `"$DATA`" --product > `"$env:TEMP\pg-attach.json`" 2>&1"
$rt = (Get-Content "$env:TEMP\pg-attach.json" -Raw | ConvertFrom-Json).runtime
$pass = $rt.pgpass_file -replace '\\', '\\'
$conn = "host=127.0.0.1 port=$($rt.port) dbname=orgtree user=$($rt.admin_role) passfile='$pass' options='-c default_transaction_read_only=on'"
& "$PGBIN\psql.exe" -w $conn -c "SELECT org_id, slug FROM public.orgs WHERE deleted_at IS NULL ORDER BY slug"
```

`default_transaction_read_only=on` makes this session unable to write. The
password is read from the database's own password file (`pgpass.conf`);
inside a connection string a backslash must be written twice, which is what
the `-replace` line does. `-w` makes `psql` fail at once instead of waiting
for a password if that file cannot be used; if it fails, report the message.

**Counts for one org** (replace `N` with its `org_id` from the list above):

```powershell
& "$PGBIN\psql.exe" -w $conn -c "SELECT (SELECT count(*) FROM org_N.nodes) AS agents, (SELECT count(*) FROM org_N.doc WHERE starts_with(key, 'work_items' || chr(31))) AS open_tickets, (SELECT count(*) FROM org_N.log_l WHERE sect = 'work_items_archive') AS archived_tickets, (SELECT count(*) FROM org_N.log_d WHERE sect = 'mail_log') AS mail_history"
```

**The same counts from the backup** (replace `<slug>`). The small script is
saved to a file first, because Windows PowerShell drops the double quotes
inside a program passed on the command line:

```powershell
@'
import json, pathlib, sqlite3, sys
path = pathlib.Path(sys.argv[1])
db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)   # read-only
one = lambda sql: db.execute(sql).fetchone()[0]
items = one("SELECT val FROM doc WHERE key = 'work_items'")
print({"agents": one("SELECT count(*) FROM nodes"),
       "open_tickets": len(json.loads(items)) if items else 0,
       "archived_tickets": one("SELECT count(*) FROM log_l WHERE sect = 'work_items_archive'"),
       "mail_history": one("SELECT count(*) FROM log_d WHERE sect = 'mail_log'")})
'@ | Set-Content -Encoding utf8 "$env:TEMP\orgtree-count.py"
& $PY "$env:TEMP\orgtree-count.py" "$BACKUP\orgs\<slug>.db"
```

**One record by name**: pick a ticket the user knows (its slug is in the app),
and compare its stored text on both sides:

```powershell
& "$PGBIN\psql.exe" -w $conn -At -c "SELECT val FROM org_N.doc WHERE key = 'work_items' || chr(31) || '<ticket-slug>'"
```

In the backup, the same ticket is one element of the `work_items` list in the
`doc` table. After launch it may have changed if someone worked on it.

**Stop the database again** when done:

```powershell
cmd /c "`"$PG`" stop --root `"$DATA`" --product > `"$env:TEMP\pg-stop.json`" 2>&1"
Get-Content "$env:TEMP\pg-stop.json"
```

Expected: JSON with `"ok": true`. The custodian always answers in JSON;
`"ok": false` with a `code` and `message` means it refused. Report it.

**Transcripts and attachments** stay files and are not converted. The script
compares them file by file. By hand, count attachments on both sides:

```powershell
foreach ($d in $BACKUP, $DATA) { (Get-ChildItem (Join-Path $d 'scratch') -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\(uploads|outbox)\\' }).Count }
```

Expected: the second number is at least the first.

## 5. What to report back

Give the user, for the Orgtree team:
- the verdict line and the exit code from section 3, and
  `%USERPROFILE%\orgtree-verify.json`;
- the version and commit from `build-info.json`;
- the output of every section 4 command you ran, and whether its numbers
  agree with the script's;
- every `PROBLEM:` line or refusal, word for word;
- `data\conversion\current.json` and the newest `data\conversion\<...>\`
  folder;
- whether the database was stopped again at the end.

Do not send the contents of `data\pg\`, any `.db` file, or the samples in the
JSON report outside the user's PC unless the user agrees. They hold the
user's private data.
