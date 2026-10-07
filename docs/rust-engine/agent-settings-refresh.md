# Agent settings refresh

User requests: 2026-10-07 16:45–16:49 UTC.

The name and existing agent actions move above the tabs. The model badge
replaces the gear in the window header, including pinned and detached headers. The Agent
tab is removed. Existing rename, retire, rescind, rehire, dissolve and permanent
delete actions keep their handlers and confirmations. The user eye opens Org
settings, not this agent panel. Archived agents retain rehire and delete; legacy
bearers still hide rename. The normal Save and Cancel behavior is unchanged;
the existing Rename button remains the name's explicit save action.

The horizontal bar now uses `CreditBarPaint`, `CreditBarStats`, and
`creditBarBackground` shared with the canvas bar. Its 14 px paint is rotated,
so segment shapes, borders, gradients, ruler and colours have one source. The
canvas annotation is always visible above it. A relative drag from anywhere
on the bar changes the grant; there is no separate handle.

At rest the visible grant range is twice the saved grant, capped by the real
maximum, with four credits of range for zero/tiny grants. After a drag crosses
the six-pixel dead zone, holding its pointer in the rightmost 10% expands the
range over time. Moving left reduces it toward the starting range. Releasing
uses the existing reallocate call. Cancel, unmount, refusal and observed credit
changes stop the animation; keyboard steps still work. No engine changes.

Agent settings use the shared `SetRow`, `SetBlock`, `SetGroup` and `SetToggle`
components from App/Org settings, including their alignment and control styles.
Only full-width content (instructions and folder lists) and the model badge
have different layouts. Setting values, availability, save handlers and the
existing confirmation dialogs are unchanged.

## Wording review: old → new

| Old label / description | New label / description |
|---|---|
| rename… | **Name** — Renaming also moves this agent’s folder and mailbox. |
| Unlabelled lifecycle buttons | **Agent actions** — Retire, restore, or permanently remove this agent. |
| Credit grant with separate number and “Seat · committed · free” line | **Credit grant** with the shared canvas annotation; “Drag the bar or use arrow keys; hold near the right edge to add more.” |
| Changing a setting restarts the process and re-sends its prompt; wider/free fields explain themselves | Some changes restart the agent, as noted below. |
| charter; restarts process and re-sends prompt | **Instructions** — What this agent should do; changes restart its process. |
| team charter; explanation of subtree prompt changes | **Team instructions** — Shared instructions for this agent and its team; changes restart their processes. |
| model (switchable on the fly — context survives; cheaper frees the seat difference…); provider/cache explanation | **Model** — Choose its model; switching providers starts a new conversation. |
| model version | **Model version** — Choose a specific version or use the latest. |
| thinking effort (user-approved: a deep setting, never a hire-row control) | **Thinking effort** — Choose how much effort the model spends reasoning. |
| account / PARKED missing-account marker | **Account** — Choose the signed-in account this agent uses; when missing, the description names the missing account instead. |
| Automatic account fallback; multiple sentences about switching, capacity and providers | **Switch accounts when limited** — Use another account with room when this one reaches its limit; unsupported providers say so, and Codex retains its new-conversation warning in one sentence. |
| cache-protective cheap compaction; detailed cache expiry rules | **Start fresh when needed** — Start a new conversation with a summary when reusing the old one would cost more. |
| context ≥ | **Conversation size** — Start fresh once the conversation reaches this share of its limit. |
| this turn, as the CLI resolved it (№14) | **Current session** — The model and tools reported by the running agent. |
| QUEUED switch warning | **Pending model change** — Switch to [model] when the current turn ends; button: **Cancel change**. |
| folder access | **Folders** — Choose which folders the agent can read or change. |
| or any absolute path — superiors are raised to carry it / top-level grant freely | Add a folder path |
| terminal (Bash) | **Run commands** |
| web browsing (search + fetch) | **Browse the web** |
| file editing (Write / Edit / notebooks) | **Edit files** |
| ephemeral subagents (Task / Agent tool) | **Use helper agents** |
| MCP servers (from your global registry); multi-sentence restart explanation | **Connected tools** — Choose tools from the shared registry; changes restart this agent. |
| parent doesn't hold it | The superior does not have this permission/tool. |
| org-structure visibility; prompt/cache explanation | **Visible agents** — Choose how much of the organization this agent can see. |
| self / team / subtree / full (default) | Only this agent / Its team / Its team and all reports / Everyone |
| permission mode — bypassPermissions is the ONLY mode… | **File and command access** — Unrestricted access removes approval prompts, including for shared skill files. |
| plan / default / acceptEdits / bypassPermissions with technical explanations | Read only / Ask before changes / Allow normal changes / Unrestricted access |
| inherit — org default / inherit the org setting / on or off for this agent | Organization default / On / Off |

The canvas annotation intentionally keeps its existing “grant / alloc / free /
seat” wording and formatting, as explicitly requested. Confirmation dialogs and
model identifiers are retained rather than changing action semantics.

## Verification

Typecheck and mounted Electron smoke, with fixture data and stubbed operations;
no live engine or installed app is exercised. Before/after images for every tab,
scrolling through long panels, and separate expanded/zero-grant bar images live
in the worktree's ignored `artifacts/settings-evidence/` folder. The hand-in
records final measured outcomes and any limitations.

## Follow-up, 2026-10-07 17:14 UTC

Rescind is shown for every live agent. Source inspection of Rust `domain/ops.rs`
and 3.x `ledger.py` confirms that top-level rescind archives the agent and its
subtree without reducing any superior grant. Its confirmation describes that
case; subordinate confirmations retain the grant-reduction explanation.
