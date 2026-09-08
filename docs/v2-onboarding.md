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

Verification: `python -m unittest tests.test_charter_documents` (isolated
HOME, never the real `~/.orgtree`), `npm test` (preference policy), and
`node tests/run.mjs onboarding` under `apps/desktop/renderer` (gate,
completion order — populate before the `onboarded` flag — and theme
persistence through a fake bridge).
