# Windows taskbar navigation (4.4.0)

Right-clicking Orgtree's taskbar icon offers Home, New org and the current
organizations. Home opens a homepage window. New org opens a fresh Create
window. An org uses `requestOrgWindow(slug, null)`: focus its canonical
window if present, otherwise open it. Existing drafts and other org windows
keep their normal ownership and close behavior.

The menu uses Electron's Windows **user tasks**, so it does not depend on
Windows allowing recent-document tracking or custom document categories.
Windows owns the menu's placement and available display space. The app does
not impose a recent-org limit. The existing native app feed supplies active
org membership and summary names in the same ascending slug order as the
org switcher. Trashed orgs are omitted; a missing name falls back to the slug.
Additions, deletions and renames rebuild the tasks; attention/runtime pulses
with the same contents do not write to the Windows shell.

Each task launches the current executable with a single
`--orgtree-taskbar=home`, `new` or `org:<slug>` argument. Development adds the
quoted app path before that argument. Org names remain display text and never
become command arguments. The parser accepts exactly one target with the
existing lowercase org-slug alphabet. Installer control retains priority.
Cold-launch and second-instance targets queue until the window routes exist;
a cold task launch opens its destination instead of restoring unrelated saved
windows. Internal relaunches omit this one-shot argument and follow their
ordinary saved-window behavior. A stale/deleted task takes the existing org
window error route rather than silently selecting a different organization.

Shell refusal is logged without crashing the app or retrying on every agent
activity pulse. A later changed list makes another attempt. While the app feed
is disconnected, the last known list stays until a current snapshot arrives.

## Focused verification

`tests/taskbar-jumplist.test.mjs` exercises the actual parser, task builder,
feed projection and extracted shipping routing/publication closures against
synthetic state and native API doubles. It covers names and membership changes,
argument validation, development paths, ordered startup handoff, shutdown,
Windows-only publication, duplicate-update suppression and shell failure.
No test writes a real Windows jump list, launches the installed app or reads
its data. A real Explorer menu and installed-executable handoff remain for the
coordinator's local-alpha quick smoke.
