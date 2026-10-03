# Hot-operation comparison on a disposable copy

`measure-orgdb-hot.py` emits `<output>.json` and `<output>.md`. It measures the
current checkout twice: `ORGTREE_STORAGE` off, and `ORGTREE_STORAGE=orgdb`.
This compares storage paths in the same code, not two release versions.

Restore the authorized dump from `artifacts/livecopy-20261002/orgtree.dump`
into a uniquely named template on **your own custodian dev cluster**. Do not
restore it into the live cluster. The template is an input, never modified or
dropped by the tool; the caller must drop it afterwards. Start, restore, measure,
cleanup and stop all belong inside one P03 heavy wrapper. Configure only this
disposable cluster's `fsync`, `synchronous_commit`, `full_page_writes` off.

Inside the wrapper, put the custodian's URLs in
`ORGTREE_TEST_PG_ADMIN_URL` and `ORGTREE_TEST_PG_RUNTIME_URL`, without printing
them. Then run (using the repository runtime Python):

```powershell
& $python -I tools/measure-orgdb-hot.py --agent deltas-sol `
  --template hot_copy_template --org orgtree `
  --agents coordinator-opus,coordinator-astra-2 --runs 5 --warmups 2 `
  --output artifacts/orgdb-hot/run-001
```

The outer launch is `tools/p03-run.ps1 -Agent deltas-sol -Candidate <commit>
-Wait -Run @('powershell.exe', '-NoProfile', '-File', <wrapper>)`. The tool
checks that this named heavy wrapper is an ancestor and that both connection
targets' actual `data_directory` lies under `artifacts/p03-db/<agent>`.
It refuses other hosts, clusters, runtime roles and malformed template names
before creating a database. URLs go to children through stdin, never arguments
or output files. Children use isolated homes/data roots and scrubbed provider
credentials. Provider and other process launches are denied during measurement;
the shared guard allows only its fixed read-only Git metadata commands. Startup
alone may launch its real converter.

The default operation set is all reads and writes. `--operations` accepts a
comma-separated subset for shorter P03 batches (keep each run below 20 minutes).
`--runs` is 1–100; `--warmups` is 1–20. A successful report needs every requested
sample, unchanged source inventory, matching starting document hashes and
verified database cleanup. Failed samples have no median or ratio.

## What is timed

- **Reads:** two excluded warm-up calls, then N synchronous calls in one
  isolated process per side. Calls include storage snapshots/queries, decoding,
  projection and function-local caches. The tree and foreground calls request
  a complete 200 response with no conditional header; repeat calls can reuse
  the production view caches. HTTP network transit and async scheduling are
  excluded. These are warm cached polls, not cold whole-tree builds.
- **Writes:** each individual sample has a fresh clone of the same template
  and a native conversion of that clone via `orgtree.orgdb.startup.start`.
  Both sides therefore start with the same document. Each gets the reshape
  probe's excluded `reallocate(review-sol, +1)` warm-up and `cached_org` load.
  The large move first makes `coordinator-astra-2` top-level, outside timing.
  The clock spans exactly one door/transaction call, including its COMMIT.
  There is one measurement per process/copy; previous writes never affect it.
  Replicates alternate which side runs first. This is warm engine/database
  timing after the stated preparation, not an already-repeated mutation.
- **Reset/setup:** database clone, startup/conversion and warm-up times are
  separate JSON fields. No subtraction or estimated correction is applied.
- **Scope:** all orgs feed the org-list operation; other operations use the
  chosen org and first selected agent, except foreground which includes the
  selected ID list. `document_window` reads that agent's visible ask/document
  window through the existing shared selector. Docket get chooses the first
  current item's slug outside timing. Native docket calls are marked
  **compat path** until the native docket module is present in this checkout.

The reshape plans match `opbench.py`/`mkplans2.py`: large move, large
insert-above hire, large self-subjugation and the reachable two-agent swap.
They rely on the approved copy's agent names and permissions. Hire's provider
availability gate alone is bypassed inside the isolated benchmark, as in that
probe; no provider starts, and an unexpected process launch invalidates the run.
This measures the row transaction, not provider startup or notifications sent
by a running server. Titles/charters, documents, messages, URLs and SQL text
are never put in the output; only IDs, timings, counts, hashes, paths and error
class names are recorded. Temporary source/converter logs are removed.

All generated databases have random per-group `hot<12 hex>_` prefixes.
Each group is dropped before the next; a final cleanup also catches incomplete
conversion databases. The tool never drops the input template. Cleanup failure
makes the run fail and is shown in its report. A crashed/killed Python process
cannot execute `finally`: the wrapper's `finally` must stop its own disposable
cluster, and a later run can inspect/remove its abandoned benchmark databases.

The report is performance evidence, not an independent semantic verifier.
Starting-document equality is checked outside timing using the engine's
canonical serializer, omitting only the design's dropped keys. Source raw
table counts/checksums also match before and after. Independent conversion
verification remains the separate A7/A8 rehearsal gate.
