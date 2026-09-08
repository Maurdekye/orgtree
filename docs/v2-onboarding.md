# First-run setup and charter documents

## Onboarding

A fresh installation opens a one-card setup on the welcome screen: pick the
visual theme (live preview, saved through the desktop preferences), set the
startup behavior (start at login, exit when the last window closes — the same
defaults as before: login on, exit-on-close off), and create the first
organization with the ordinary organization form. Everything on the card can
be changed later in Settings.

The card appears only when ALL of these hold: the desktop preferences are
loaded and lack `onboarded: true`, and the engine's organization list has
been fetched and is empty. Existing installations therefore never see it —
any organization, created or imported, hides it — and the list-fetched
condition prevents it flashing before `/api/orgs` answers. Finishing setup,
skipping it, or creating the first organization through the embedded form
persists `onboarded: true` in `desktop-settings.json`, so the card stays gone
even if every organization is later deleted. `onboarded` is an ordinary
boolean preference: validated in `preferencesPatch`, default `false`.

Completion is populate-then-flag, atomically from the caller's view
(`completeOnboarding`): a charter-populate failure is shown on the card and
the flag is NOT written, so pressing finish again retries. On the
organization-creation path the card unmounts as soon as the first
organization exists, so completion runs inside `onboardingCreate` — after
the create succeeds and before the caller refreshes the list — never in a
child effect that would unmount before firing. A populate failure there is
surfaced as a toast, the organization still opens, and `onboarded` stays
unset: setup returns to offer the seed again only if the installation is
ever back at zero organizations, while the hire form keeps serving the
bundled presets regardless. Because that state would otherwise persist with
no affordance, App settings → runtime carries a "Charter documents »
populate missing documents" action calling the same idempotent populate
route, with pending/success/error feedback and a visible retry — existing
files are never changed, and it neither reopens setup nor touches
preferences (coordinator ruling 2026-09-08).

## Charter documents

`~/.orgtree/charters/` is the documented, user-editable charter document
location: every `.md` file there is a charter preset offered by the hire
form. The engine also ships bundled presets in `engine/docs/charters/`
(restored from V1 — the copied V2 layout had broken this path and served an
empty list). `GET /api/charters` merges both: a user file wins over a bundled
preset with the same filename, and each record carries `source: "user" |
"bundled"`, its `file` name and the resolved `path`.

Completing (or skipping) onboarding calls `POST /api/charters/populate`,
which copies every bundled preset into `~/.orgtree/charters/`, creating the
directory when needed and NEVER overwriting an existing file — user edits
survive every later populate, reinstall or onboarding of another machine
profile. `PUT /api/charters/<name>` writes one document into the user
directory (plain names only — letters, digits, spaces, `-`, `_` — so a
request can never name a path outside it; bodies are bounded at
`PRESET_MAX`). Per-agent charters live in each organization document and are
untouched by all of this.

Every charter route applies the importer's reparse rule
(`desktop_import._plain`): a junction or link at `~/.orgtree/charters`, any
existing ancestor, or a save target refuses populate and save with 409 and
makes the listing declare `user_dir_error` while still serving the bundled
presets — nothing behind a link is ever written through or served back as
the user's documents (redteam finding, demonstrated with a real junction and
covered by `test_junction_at_the_charters_directory_refuses_every_route`).

One deliberate edge (redteam observation, kept as-is): an installation that
predates the `onboarded` preference and stands at zero organizations — for
example after deleting its only organization — sees the setup card once. It
is skippable in one click, and populate never overwrites, so the cost is a
card and at most seeding absent preset files.

Verification: `python -m unittest tests.test_charter_documents` (isolated
HOME, never the real `~/.orgtree`), `npm test` (preference policy), and
`node tests/run.mjs onboarding` under `apps/desktop/renderer` (gate,
completion order — populate before the `onboarded` flag — and theme
persistence through a fake bridge).
