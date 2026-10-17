# Windows taskbar navigation (4.4.0)

Right-clicking Orgtree's taskbar icon offers Home, New org and the current
organizations. Home opens a homepage window. New org opens a fresh Create
window. An org uses `requestOrgWindow(slug, null)`: focus its canonical
window if present, otherwise open it. Existing drafts and other org windows
keep their normal ownership and close behavior.

The menu uses a custom **Recent** category for orgs at the top and Windows'
**Tasks** section for Home and New org at the bottom, matching Hubchat. There
is no separator inside Tasks. If Windows privacy policy refuses custom
categories, the app retains the fixed Tasks without changing that setting.
Windows owns the menu's placement and available display space. The app does
not impose a recent-org limit. The existing native app feed supplies active
org membership and summary names in the same ascending slug order as the
org switcher. Trashed orgs are omitted; a missing name falls back to the slug.
Additions, deletions, renames and logo changes rebuild the list; attention/runtime pulses
with the same contents do not write to the Windows shell.

Each org uses its logo when present, otherwise the executable's app icon.
Home uses the app's HomeOutlined silhouette; New org uses the Add/plus glyph.
The main process writes bounded PNG-backed ICOs under its own userData
`jump-list-icons` folder. Content-addressed paths change with the logo so
Explorer cannot keep displaying a previous picture at the same icon path.
The app feed advertises only the logo's SHA256; the authenticated loopback
picture endpoint supplies bytes on change. Reads are bounded, serialized,
hash/dimension checked before native decode, and resized to at most256px.
Missing, corrupt or stale responses keep the fallback and retry on later feed
events at most once per hash per30seconds. Late completions never replace the
current feed's chosen logo. Old content-addressed files can be reused after
restart or undo; picture bytes never enter feed frames or trace output.

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
The feedback specifications first measured9tests/4expected assertion failures
and5controls before implementation. Further synthetic cases cover valid ICO
files, separate action glyphs, changed/removal/stale/corrupt logos, bounded
admission and Windows privacy fallback. Final green evidence lives on the docket.
No test writes a real Windows jump list, launches the installed app or reads
its data. A real Explorer menu and installed-executable handoff remain for the
coordinator's local-alpha quick smoke.
