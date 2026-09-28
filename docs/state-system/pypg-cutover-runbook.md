# Upgrading from Orgtree 2.1.12 to v3: the automatic data conversion

This guide is for the user, or for a coding agent working on the user's
behalf in an ordinary terminal **outside** Orgtree. It explains what happens
to the data when Orgtree v3 is installed over 2.1.12, how to confirm that the
conversion worked, what to do when it did not, and how to go back to 2.1.12.

You do not run the conversion yourself. Orgtree v3 does it by itself the
first time it starts. The steps below are the backup before it, the checks
after it, and the way back.

## 1. Words used here

- **Orgtree**: the desktop app. It runs a background program called the
  **engine** (a Python process) that reads and writes the data.
- **Data folder**: `%APPDATA%\Orgtree v2\data` (for example
  `C:\Users\<name>\AppData\Roaming\Orgtree v2\data`). Everything Orgtree
  stores is in it. v3 uses the same folder as 2.1.12.
- **User-data folder**: `%APPDATA%\Orgtree v2`, the folder that holds the data
  folder plus the app's window and browser settings.
- **Organization (org)**: one team inside Orgtree, with its agents, tickets
  (work items) and mail. **Slug**: the org's short name.
- **SQLite**: the storage 2.1.12 uses: one database file per org,
  `data\orgs\<slug>.db` (sometimes with `<slug>.db-wal` and `<slug>.db-shm`
  beside it).
- **PostgreSQL**: the database server v3 uses instead. v3 carries its own
  private copy, stored in `data\pg\`, reachable only from this PC
  (127.0.0.1). No separate PostgreSQL install is needed.
- **Conversion**: v3 copying every org from SQLite into PostgreSQL on its
  first start, checking the copy, and then switching over.
- **Cutover record**: the file `data\store-backend.json`. When it says
  `"backend": "postgres"`, Orgtree uses PostgreSQL. The conversion writes it
  last, and only after every check passed; it then also says
  `"via": "first-launch-conversion"`.
- **Rollback folder**: `data\pre-postgres\orgs\`. After the switch, the old
  SQLite files are moved here **unchanged**, so they can be put back.
- **Marker file**: `data\orgs\<slug>.pg`, a small file saying that this org
  now lives in PostgreSQL.
- **Conversion log folder**: `data\conversion\<date-time>-<number>\`. Each
  conversion attempt writes its reports and logs here.
- **Status file**: `data\conversion\current.json`. It holds the conversion's
  latest step and, at the end, `done` or `failed` with the reason.
- **Install folder**: where Orgtree's program files are. Normally
  `%LOCALAPPDATA%\Programs\Orgtree`, or `C:\Program Files\Orgtree` for an
  install made "for all users". Its `resources\` subfolder holds the engine,
  the bundled Python, PostgreSQL and the tools this guide uses.
- **Boot task**: the Windows scheduled task **Orgtree Background Engine**,
  which some installs use to start the engine when Windows starts, before
  anyone opens the app.
- **Event log**: the Windows Application event log. When the engine refuses
  to start it writes one line there, source `Orgtree P03`.

## 2. What happens during the upgrade

1. You quit 2.1.12 and (recommended) back up the user-data folder (section 3).
2. You run the v3 installer by hand. It replaces 2.1.12 in the same install
   folder. It does not start the app at the end.
3. The first time the v3 engine starts, it sees that the data folder still
   holds SQLite orgs and converts them before it shows anything:
   1. **Check** (reads only): every org is read and counted, and a
      checksum (SHA-256) is computed for every kind of data. Anything it does
      not fully recognise stops the conversion here, before anything is
      written.
   2. **Prepare**: it marks the data folder as Orgtree's own for its private
      PostgreSQL (`data\orgtree-product-root.json`) and creates the database
      in `data\pg\`.
   3. **Copy**: each org is copied in one database transaction (all of it or
      nothing), then read back and compared with the original byte for byte
      and by checksum. An org that does not match stops the conversion.
   4. **Switch**: only when every org passed, it writes the cutover record
      and moves the old SQLite files to the rollback folder, unchanged.
4. The engine then starts normally on PostgreSQL.

**Where the conversion runs.** Usually in the app you open. If this PC has the
boot task (all-users installs), the installer starts that task at once, so
the conversion may already be running in the background when the installer
finishes. Either way, the progress is in the status file, and the app shows
it while it waits.

**How long.** Measured on 2026-09-28 on a copy of this PC's data (four orgs,
238 MB): about 106 seconds from the first check to the switch, and about 110
seconds until the engine was ready. The longest single step was 33 seconds
(creating and starting the database). A larger store or a slower disk takes
longer. Allow several minutes. Do not close the app or turn the PC off while
it runs; if that happens anyway, see section 6, "Interrupted".

**If it fails.** Nothing is switched: the data stays in the old SQLite form,
unchanged, and Orgtree 2.1.12 can still open it. v3 does not start; it shows
a message saying what failed and where the log is (the conversion log
folder). The next start of v3 tries again from the beginning. To keep working
in the meantime, reinstall 2.1.12 (section 7).

**What is converted, and what is not.** Only the org databases in
`data\orgs\` move to PostgreSQL: agents, tickets (open and archived), mail
and mail history, turn history, every setting stored with the org. Everything
else in the data folder stays exactly where it is and is used as before:
transcripts (`transcript-records.sqlite3`, `turnlog\`), attachments and
outbox files (`scratch\...\uploads\`, `scratch\...\outbox\`), workspaces,
profiles, logs. Organizations in the trash (`data\deleted\`) are **not**
converted: if the trash holds any, the conversion refuses (section 6).

## 3. Before installing v3

1. **Quit 2.1.12 completely**: from its window and from the tray icon
   (right-click it, then Quit). If the boot task exists, stop it too. In
   PowerShell:

   ```powershell
   Get-ScheduledTask -TaskName 'Orgtree Background Engine' -ErrorAction SilentlyContinue | Stop-ScheduledTask
   ```

   (If this is refused, run PowerShell as administrator.) Then confirm that
   nothing from Orgtree is running:

   ```powershell
   Get-CimInstance Win32_Process | Where-Object {
     $_.ExecutablePath -like '*\Orgtree\*' -or $_.CommandLine -like '*Orgtree v2*' -or $_.Name -eq 'postgres.exe'
   } | Select-Object ProcessId, Name, CommandLine | Format-List
   ```

   Expected: nothing. If something is listed, wait a minute and look again.

2. **Back up the user-data folder** (recommended). This copy is the simplest
   way back (section 7):

   ```bat
   robocopy "%APPDATA%\Orgtree v2" "%APPDATA%\Orgtree v2 backup before v3" /E /COPY:DAT /DCOPY:DAT /R:0 /W:0
   ```

   Expected: robocopy's exit code is 0 or 1 (it uses 0-7 for success) and its
   summary shows 0 files `FAILED`. It needs as much free disk as the folder
   uses: on this PC the transcript database alone is about 11 GB. Keep the
   copy until you are satisfied with v3.

3. **Keep the 2.1.12 installer**, `Orgtree-Setup-2.1.12.exe` (the GitHub
   release v2.1.12), in case you need to go back.

## 4. Install and start v3

1. Run `Orgtree-Setup-3.0.0-alpha.0.exe`. It installs over 2.1.12, keeps the
   same Start-menu entry "Orgtree", and does not start the app at the end.
   Automatic updates are off in this build.
2. Start Orgtree from the Start menu. On the first start it shows that a
   one-time conversion is running and which org it is on. Wait for it.
3. When the app opens as usual, the conversion is done. Check it (section 5)
   before relying on v3.

## 5. Confirm that the conversion worked

### Quick check (a minute)

With Orgtree quit (and the boot task stopped, section 3.1), in a Command
Prompt:

```bat
type "%APPDATA%\Orgtree v2\data\conversion\current.json"
type "%APPDATA%\Orgtree v2\data\store-backend.json"
dir /b "%APPDATA%\Orgtree v2\data\orgs"
dir /b "%APPDATA%\Orgtree v2\data\pre-postgres\orgs"
```

Expected:
- `current.json` shows `"state": "done"` and `"reason": null`;
- `store-backend.json` shows `"backend": "postgres"`,
  `"via": "first-launch-conversion"`, and one entry per org under `"orgs"`;
- `orgs` lists only `<slug>.pg` files, one per org;
- `pre-postgres\orgs` lists every `.db` (and `-wal`, `-shm`) file that
  2.1.12 had in `orgs`.

Then open Orgtree and look: every org is in the list, and a ticket and a
recent mail you know well are there as before.

### Full check (independent)

The full check compares the backup from section 3.2 with the converted data,
row by row, using only the installed app's own Python and PostgreSQL. It does
not use the code that did the conversion, so it can be run by an outside
agent that did not take part. It is written up separately, with exact
commands, what PASS looks like and what to report:
[the verification procedure](pypg-cutover-verification.md).

## 6. Troubleshooting

In every case, keep the conversion log folder and copy the **exact** message
into your report (section 8).

**v3 shows "Orgtree could not convert your data to its new database".** The
message says what failed, whether anything was switched, and where the log
is. The usual reasons:

- *"some data is not recognised: ..."*: the check found data it does not fully
  understand (for example an unknown kind of record, a stray file in
  `data\orgs\`, a `.json` org beside a `.db` org, a text value PostgreSQL
  cannot hold). It refuses rather than guess. Nothing was written. Do not
  edit or delete data to get past it: reinstall 2.1.12 and send the log
  folder (its `dry-run.json` lists every problem).
- *"the trash holds N file(s) of deleted organizations"*: the conversion does
  not carry trashed orgs over. Reinstall 2.1.12, restore those orgs or delete
  them permanently from the trash, then install v3 again.
- *"... is in use (its owner lock is held)"*: another Orgtree engine was
  running on the same data folder. Quit everything (section 3.1) and start v3
  again.
- *"read-back does not match"* or *"is not byte-identical"*: an org's copy
  in PostgreSQL differed from the original. Nothing was switched. Do not
  retry repeatedly: reinstall 2.1.12 and send the log folder.
- *"pg-custodian ... refused"* with a code: the private database could not be
  prepared or started. `port.occupied` / `port.pick`: an old `postgres.exe`
  is still running (section 3.1 lists it); `root.protected` or
  `product.not_engine_root`: the engine was started in an unexpected way (for
  example from inside an agent session); `root.reparse_point`: the data folder
  is a link or junction. Send the message.
- *"the bundled importer is missing"* or *"packaged PostgreSQL executable is
  missing"*: the install is incomplete. Reinstall v3; if it repeats, send the
  message.

**Interrupted** (the app was closed, the PC turned off or crashed during the
conversion). Start v3 again. If the switch had not happened yet, it starts the
conversion again; orgs already copied and checked are skipped. If the switch
had happened but the old files were not all moved yet, it finishes moving them
and starts. `current.json` may say `"running"` for an attempt that was
interrupted; the next start replaces it.

**v3 refuses to start after the conversion succeeded** (the event log, source
`Orgtree P03`, has an `Error` line; its message is JSON naming the reason).
Send the line and go back (section 7).

**Anything else** (a Python traceback in a log, an unexpected exit): send it.

## 7. Going back to 2.1.12 (rollback)

**Anything written in v3 after the switch exists only in PostgreSQL and is
lost when you go back.** That is accepted for this upgrade.

1. Quit Orgtree completely and stop the boot task (section 3.1).
2. Run `Orgtree-Setup-2.1.12.exe`. It installs 2.1.12 over v3 in the same
   folder. (No version check blocks this, according to the installer's
   source. It has not been tried.)
3. Put the data back. Choose one:
   - **A. The conversion failed** (v3 said "Nothing was switched"): nothing
     to do. 2.1.12 ignores what the attempt left behind (`pg\`, `conversion\`,
     `orgtree-product-root.json`, and any `.pg` marker files beside the
     `.db` files): it only looks for `.db` and `.json` files in `orgs\`.
     (Read from 2.1.12's code; not tried.)
   - **B. From the backup** (section 3.2), the simplest and most complete way:

     ```bat
     ren "%APPDATA%\Orgtree v2" "Orgtree v2 after v3"
     robocopy "%APPDATA%\Orgtree v2 backup before v3" "%APPDATA%\Orgtree v2" /E /COPY:DAT /DCOPY:DAT /R:0 /W:0
     ```

     Keep `Orgtree v2 after v3` until 2.1.12 runs well; the team may want to
     look at it.
   - **C. Without a backup**, from the rollback folder:

     ```bat
     cd /d "%APPDATA%\Orgtree v2\data"
     ren store-backend.json store-backend.json.after-v3
     mkdir pre-postgres\markers
     move orgs\*.pg pre-postgres\markers\
     move pre-postgres\orgs\* orgs\
     ```

     Check: `dir /b orgs` shows the `.db` files again and no `.pg`, and
     `store-backend.json` is gone. Leave `pg\` alone.
4. Start Orgtree 2.1.12 and confirm the orgs look as before.

If you later install v3 again after going back with C, v3 treats the data as
2.1.12 data and converts it again.

## 8. What to send back

Put these in one folder and give it to the user for the Orgtree team:
- the whole conversion log folder (`data\conversion\`), including
  `current.json`;
- `data\store-backend.json` (if it exists);
- the output of `dir /s /b "%APPDATA%\Orgtree v2\data\orgs" "%APPDATA%\Orgtree v2\data\pre-postgres"`;
- the exact text of every message, and the event-log lines (source
  `Orgtree P03`);
- the verification report, if you ran the full check;
- `<install folder>\resources\build-info.json` (the installed version);
- which step you stopped at, and whether you went back.

Do not send the contents of `data\pg\` or any `.db` file unless asked. They
hold the user's private data.
