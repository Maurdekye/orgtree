# Event fixtures — generated, not hand-maintained

Every `*.json` file in this directory is **generated output**. There is one file per declared
event variant, and each holds that variant's `private` encoding, its `public` projection and its
rendered agent-facing `body`. They are the reference for what an event actually looks like on the
wire, which only works for as long as they match the code that emits it.

**Do not edit these files by hand.** If an event's payload or its rendered body changes, change it
in the backend and regenerate.

## Source of truth

Truth flows in one direction:

```
engine/backend/orgtree/{events_table,events_render,events_fixtures}.py   →   this directory
```

Regenerate from the repository root:

```
python tools/gen_event_fixtures.py          # rewrite every fixture
python tools/gen_event_fixtures.py --check  # report drift, write nothing
```

The generator pins itself to **this repository's** backend: it puts `engine/backend` at the front
of `sys.path` and then refuses to run at all unless `orgtree` resolves below that directory. That
guard is not decoration. On a machine with Orgtree installed, a bare `import orgtree` picks up the
packaged build under `C:\Program Files\Orgtree\resources\engine\backend\orgtree` instead, and
regenerating from it silently sources these fixtures from an old release — producing a diff that
looks like a routine regeneration and is not. If the generator stops with a "refusing to run"
error, that is the guard working; fix the environment rather than bypassing it.

`tests/test_engine_work_deploy_ready.py::GeneratedEventsInSyncTests::test_event_fixtures_match_source`
asserts there is no drift, so a hand-edited fixture now fails the suite instead of surviving in it.
`apps/desktop/renderer/tests/eventdecode.test.ts` separately validates every fixture through both
row profiles and asserts the file count equals the variant count.

## Why this file exists

Three fixtures drifted from the generator and stayed drifted for three days without the suite
noticing, because at the time nothing here said the files were generated and no test compared them.

- `docket.assigned.json` and `docket.review_requested.json` — the committed fixtures were stale.
  `e081d39` added the `acceptance` field to the docket payloads and to the rendered bodies, then
  patched these two files by hand rather than regenerating. The hand-edit is visible in the result:
  the placeholder read `"docket.assigned acceptance"` instead of the generator's
  `docket.assigned·acceptance[0]` convention, the list was inline rather than indented, the key
  landed out of field order in `public`, and the `body` string was never updated — so it was
  missing the `Acceptance conditions: …` line that the renderer had started emitting.
- `runtime.delivery_unread.json` — the committed fixture was stale. Its `body` still carried
  wording that `5bb3cc9` and `d7ba8d1` had already replaced in `events_render.py`.

All three were stale committed fixtures; the generator was correct in every case, and none of them
was a deliberately pinned exception. They were regenerated in `db0761a`, and `6226133` added the
repository pin described above.

If a fixture ever does need to differ from generator output, that is a hand-maintained exception
and it cannot live here silently: record the reason and make the generator produce it, because the
sync test will otherwise fail on it.
