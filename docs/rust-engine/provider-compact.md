# Compact Providers presentation

User request, 2026-10-12 20:22Z: reduce the Providers menu's extra space and
unnecessary captions. This is presentation work; provider eligibility, account
authentication, billing/fallback, enablement and request handlers stay unchanged.

Provider availability sits in the header with the add-account/server controls.
Account active switches sit beside their identities. The visible switch words
are short (Enabled/Active), while accessible names still identify the exact
provider/account and purpose. The Add account button retains the accessible name
Add secondary account. Native checkbox/keyboard behavior remains in SetToggle.

Remove the idle Installed harnesses and accounts caption, the Model tiers caption
(the model group retains its accessible label), duplicate CLI names, and repetitive
switch explanations. Refreshing/error/unknown/sign-in/preview/update information,
account identities, inactive explanations, server state, usage and reset details
remain visible. Billing-sensitive fallback explanations remain. On narrow screens,
header actions wrap and long identities stay readable. Buttons/label hit areas stay
at least 28px high in the scoped presentation. Existing add/configure dialogs and
model browsers remain separate surfaces with their original draft/save semantics.

CSS is scoped to `#app-settings-panel-providers`; other settings tabs and portaled
configuration dialogs keep their existing spacing. Generic provider/account markup
supports additive provider rows, including Muse. Individual OpenRouter key rows
retain the original/default distinction, key names, account balance, inactivity,
switches and actions; runtime owners retain those behaviors. Each key's switch is
compact like an account's: "Active" on the key's identity line (its own line below
520px, where the icon buttons leave the name no room), accessible name
"<key> active", the "Allow this key to serve new turns." caption removed.

## Verification and limits

### Language servers terminology (2026-10-12 21:22Z)

The provider class and collection are named Language servers. Updated category
surfaces: Providers heading; tier-family menus/cards; agent settings model-family
choice; canvas hire model-family list; template picker provider label; shared
provider display label; Language servers Gold theme. Engine display metadata and
error navigation pointers match the renamed Providers category. Org Accounts
already used Language servers.

Audit correction (rig-opus, 2026-10-13): the engine's `catalog::provider_label`
names the provider of one agent, so it stays "Language Server". Making it plural
had produced "the Language servers process exited during the turn" and
"Language servers is turned off in App settings". The switch in App settings ›
Providers belongs to the whole class, so refusing work because it is off says
"Language servers are turned off in App settings" (`catalog::turned_off`: hire
and move refusals, the Providers payload's reason, and the runtime's route
check). The lineage panel's note likewise reads "Language servers are off".

Singular text remains where it names one server: Add language server/configure/
remove actions, one server's model-selection dialog, per-server Usage cards,
session explanations and individual-server errors. External CLI configuration
names, agent-tool wire labels and protocol/API/storage identifiers are outside
this UI copy change. No logic, CSS, model IDs or account/auth behavior changed.
The independently reviewed compact snapshot stays at 5b091bc; terminology follows
on a separate branch and engine/display copy commits. Existing copy expectations
are updated without adding implementation-mirroring tests.

### Compact layout

`provider-compact-probe.tsx` mounts the actual AccountsPanel with synthetic
provider/account/server states and refuses writes. `provider-compact-visual.mjs`
resolves real dependencies without linking or copying node_modules, bundles the
fixture, and uses the supported offscreen Electron driver. Run the entire command,
including bundling, under `tests/joblimit.ps1` with a kernel memory/deadline limit
and the machine-wide build slot. Build outputs belong in the assigned C root;
renderer profiles, screenshots and evidence stay in the agent's D evidence root.

The baseline at 7f5ad2e measured 2058px wide / 2584px narrow content height in both
themes. The corrected render at 62eb7c7 measured 1274px / 1783px, reductions of
38.1% / 31.0%. All 31 controls were reachable in each of the four cases, tab scroll
width equaled client width, and the corrected controls' label/button/link hit areas
were at least 28px high. Baseline dark wide and light narrow screenshots and
corrected wide/narrow screenshots in both themes were inspected, including narrow
server rows. Source typecheck passes with explicit shared-dependency resolution.
All 50 focused behavioral tests pass across account creation/removal, marks,
API-key fallback and usage, provider discovery, OpenRouter models/usage, language
servers and dialogs. Their bundling and execution used the same 4096MB/150s kernel
Job containment. No installed app, live settings, provider inference, packaging or
publication was tested.

### Composition with OpenRouter keys and Muse (2026-10-13)

rig-opus composed the layout and terminology onto rust-engine 1e2d4e1, which
carries several OpenRouter keys and Muse Code. Muse renders through the generic
provider and account rows and needed no change. The per-key OpenRouter switch was
new, so it now follows the account switches (above). The fixture adds a Muse
provider with its three tiers, a managed Muse login with an agent and a Muse
API-key account, and three OpenRouter keys: the named original, a named added key,
and an inactive key openrouter.ai refused.

Measured with that fixture, before (base plus fixture) and after, in both themes:
content height 3210px to 1863px wide (-42.0%) and 4017px to 2690px narrow
(-33.0%); OpenRouter 583px to 322px and Muse 760px to 400px wide. Wide key rows
went from 117-147px to 59-78px, each switch on its identity line. All 52 controls
were reachable in all four cases, scroll width equaled client width, and the
smallest label/button hit area was 28px (18.6px before). The keys test's new
check of the short label and per-key names fails before the change and passes
after it. The 36 suites that render the Providers panel, its account and key
rows, or the label lines shared with Muse (257 tests) pass.

Limit: at the 303px narrow panel the key rows cut off the key's name and verdict,
before and after (the tooltip carries them, and a refusal stays visible on the
spend line); the row's own layout belongs to its owner.

### OpenRouter key actions and provider drafts (2026-10-13)

The OpenRouter provider header now owns one add action beside its enable switch,
using the same `acct-secondary-btn` as other providers' Add account. With no key
it opens the first-key form; with any remaining key (including added-only keys)
it opens the additional-key form. Neither action is repeated beneath the rows.
The original key's Replace settings uses the shared name/optional-key form:
name-only saves rename, a supplied key replaces and renames together, and an
empty custom name restores the existing provider-label meaning. There is no
separate naming button or dialog. Existing endpoints and activation are retained.

Shared ProviderDialog drafts, including language server add/configure, dismiss
on idle backdrop clicks or Escape. Unsaved fields are discarded as with Cancel,
focus returns to the opener, and a busy save blocks dismissal. PinFrame records
where the pointer started so a text-selection drag ending outside the panel
cannot dismiss it; pinned and detached behavior retains its existing gates.
Focused renderer checks and `provider-key-visual.{mjs,cjs}` exercise these paths
using synthetic documents only; installed/provider behavior requires separate
evidence. Earlier layout measurements above retain their historical provenance.
