# Orgtree 2.1.9-beta.3

beta.2 made the eight-agent swarm usable. This build is the stabilization
batch on top of it: every fix that was started before the state-system
rearchitecture begins, finished, independently reviewed, landed on main, and
shipped together. The three headline changes are that changing a busy agent's
account now queues instead of being refused, Quick Staffing can carry an
account suggestion, and the window controls survive every error screen. Behind
them ride a halt that always reaches a terminal state, the full agent context
menu from every view, a usable Codex CLI lane for OpenRouter agents, and a set
of recovery and test-honesty fixes.

## Installing this build

**This is a prerelease and it is not published to the update channel, so the
tray's Update now will not offer it.** You install it by running the installer
file you were sent, by hand.

The installer closes Orgtree and waits for every agent to stop before it
replaces any files. It does not force anything — it waits — but every agent's
current turn ends, and that cannot be undone. Pick a moment when losing
in-flight work is acceptable.

Nothing was published, installed, restarted or shut down in producing this
build.

## Changing a busy agent's account now queues

Before this build, moving an agent to a different signed-in account while it
was mid-turn was refused, and you had to catch the agent idle. Now the request
is accepted immediately and recorded durably: the active turn finishes on the
account it started with, and the change is applied after that turn fully ends
and before any later turn begins — including when the turn ends by failure,
interrupt, or the process dying. If a model switch is also queued, the two
compose in the order you asked for them, and the account is validated against
where the agent is actually going. Asking for the account the agent already
has cancels a queued change; an invalid or unauthorized request changes
nothing at all; ambient "primary" selections now remember which provider they
meant, so a request to another provider's primary is never mistaken for a
cancellation. Codex sessions still archive cleanly at the boundary, and the
existing fallback rules are untouched. This path went through four independent
review rounds, each with real-writer probes, before landing.

## Quick Staffing can suggest an account

Quick Staffing settings gain one option, off by default: **Include account
selection when requesting staffing**. When it is on, staffing request
previews list the compatible accounts for lanes that need one, and the account
you pick rides along in the request mail as a suggestion ("Suggested account:
X"). The receiving agent keeps its own staffing authority — the suggestion
does not pin its eventual hire — and account eligibility and automatic
fallback behavior are completely unchanged. With the option off, nothing about
the existing flow is different.

## Window controls survive error screens

When the main window showed an error — a startup failure, a lost connection,
a renderer crash — the close, minimize, maximize and refresh controls used to
disappear with the page. They now stay visible and functional on every such
screen. Each control keeps its normal behavior, including maximize-versus-
restore state, and healthy content still shows exactly one set of controls.
The stranded holding page (the one you see when the app's port changed under
it) previously rendered a Refresh button that silently did nothing; it now
does what it says — saves your window layout, restarts Orgtree, and rebuilds
the interface.

## Halting an agent is a confirmed kill

Halt now always reaches a terminal state: it is a confirmed process kill, the
settle poll no longer spins past its own deadline, pooled and pre-admission
agents are covered, and a concurrent diagnostic can no longer knock over a
halt in progress. Stated error messages stay byte-identical through the new
paths.

## The full agent menu from every view

The canonical agent context menu now opens from every place an agent is
named, including desk-view navigation targets, with an enumeration test
pinning the reach. Nested targets resolve to the agent you actually clicked,
the copy entry is hoisted where it belongs, and an unanswerable registry can
no longer swallow the row menu.

## Codex CLI as an OpenRouter backend

A usable Codex CLI can now drive OpenRouter agents. The hire path chooses the
new agent's harness before taking the document lock, the warm pool follows
that harness, dead pool agents are no longer hired, and the login-claim
assertion was made falsifiable.

## Recovery and measurement fixes

The restart-rescue join that nobody was measuring is now measured: strand an
agent, restart, and read exactly what the rescued agent received. A newer
turn that starts and finishes during recovery is now told apart from a
missing marker, so recovery no longer misclassifies finished work.

## Test honesty

Two dormant native-desktop and mailhub test modules were woken and run again.
The test baseline was re-recorded at one current commit with every remaining
failure explained and labeled measured-versus-inferred. `@property` now counts
as the getter it is in the registration guard, and the marker-only test arm
says precisely what it isolates.

## Also in this build

The remaining items of the staffed batch — OpenRouter effort selection for
Quick Staffing, durable stage attribution for slow requests, and the
duplicate-definition test guard — shipped in 2.1.9-beta.2 and are included
here by ancestry, along with everything else beta.2 contained.

## Complete change list since beta.2

```
816008e Make the stranded holding page's refresh rebuild the window
0ad1b8c fix(desktop): keep window controls visible during main-window errors
7626c76 Add the Include-account-selection option to Quick Staffing requests
9955e97 Give ambient bindings a provider identity, and order legacy intents at acceptance
575f4ae Compose queued account and switch intents by acceptance order, not the clock
9eda40d Update the unstick-then-rebind test to the reversed mid-turn contract
5013ab3 Compose queued rebind and queued switch by request order, and thaw at the boundary
5655688 Queue account rebinds at turn boundaries
c856e51 Cover the pooled / pre-admission halt, and stop a diagnostic killing a halt
50e893c Stop the halt settle poll spinning past its own deadline
9b883de Keep stated error messages byte-identical, and tolerate minimal test doubles
7c08063 Make halt a confirmed process kill that always reaches a terminal state
2eca342 Assert the no-swallow rule on the arm f6 created (textmenu finding f1)
cc6872b Pin the over-correction: an unanswerable registry must not swallow the row menu
fa8bc2e Agent menu wins on a nested marked target; copy entry hoisted; portal bound asserted
1854e63 Upgrade two baseline notes from inferred to measured, and label all five
aa3b5c0 Re-record the test baseline at one current commit, and explain five failures
b38b303 Pin the third shape, and say what the mutations did not kill
c8a30e7 Serve the marker wherever it sits relative to the copy object
a6a7ffa Find the surface the audit missed, and say what the tests do not prove
8d4561c Pin the reach with an enumeration and a source scan
df6f267 Reach the canonical agent menu from every navigation target
ef14fc1 Stop a staffing spy from re-declaring the door's whole signature
201a6e2 Choose the new hire's harness before taking the document lock
021d0f6 Follow the harness in the warm pool, and stop hiring dead agents
4067e65 Tidy the harness module before review
c12635c Make the login-claim assertion falsifiable
f4d2233 Let a usable Codex CLI drive OpenRouter agents
26600c9 Count @property as the getter it is, and stop trusting any .register
fd66b6a Say what the marker-only arm actually isolates, and stop leaking its boxes
a8581d8 Measure the join nobody was running: strand, restart, and read what the rescued agent got
84c7d26 Correct two comments that argue for the bug this ticket fixes
f19a8c8 Use the canonical wording for the import-provenance guard
9394f7f Tell a finished newer turn apart from a missing marker
14c9bf0 Wake the two dormant native-desktop test modules
44b6176 Stop popping the long-charter note on an agent-settings save
```
