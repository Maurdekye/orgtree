---
name: orgtree-org-basic
description: Explain the org logo, credits, context threshold, effort and automatic saving.
---

Up: [orgtree-org-settings](../SKILL.md)

# Basic settings and saving

Use **Org settings > Basic** to explain this org's logo and agent defaults.
Agents suggest changes; the user edits them. The following keys live in org
settings. Effective values include app defaults and the org's own overrides;
the defaults below are the engine values when neither overrides them.

On supported native desktop shells, the **Shared scratch folder** group has
an **Open shared scratch folder** button with the folder icon. It opens the
same org-wide `_shared` directory as the switchboard context entry, creating a
missing managed folder on demand. This action does not save settings or the
charter; keep unsaved edits as they are. Browser/phone and older shells omit
the group. Personal scratch and each agent's own-led team folder remain in
that agent's Open submenu.

| Control | Key | Default | Effect and limits |
| --- | --- | --- | --- |
| Top-level grant cap | `org:max_top_grant` | 1,000 | Bounds increases to a top-level agent's grant. Lowering it preserves existing grants above the cap and returns a warning naming them. UI minimum 1, step 1; storage also supports 0 as uncapped, this form requires at least 1. Negative values are ignored. |
| Default top-level grant | `org:default_top_grant` | 20 | Prefills a new top-level hire's grant. UI minimum 0, step 1. Changing it does not reallocate existing grants. Negative values are ignored. The UI fallback is 50 when the field is absent; that is not the engine default. |
| Compaction threshold | `org:compact_at` | 80% | UI 50–95%, step 1; the endpoint refuses percentages outside that range. Stored as a percentage and exposed to the renderer as a fraction. Claude Code receives the automatic-compaction percentage at process start; Codex receives the corresponding context token limit. A running process retains its launch threshold until replaced. Antigravity has no corresponding threshold setting. |
| Default thinking effort | `org:default_effort` | empty saved value | Agents without their own effort use the org default on subsequent turns. The menu offers Default (high fallback), low, medium, high, xhigh and max. The engine accepts the catalog's additional none/minimal names as well; unknown names are refused. |

The empty effort option is labelled **Default (high fallback)**. An agent's
own effort wins, then the org's effective default; only when neither supplies
a level does `effective_effort` fall back to **high** before launch.
Each harness/model maps the effective level to its supported names; an
agent's explicit level takes precedence. No rehire is needed. Do not promise
an immediate mid-turn effort change from this org control.

The ordinary compaction threshold also governs Orgtree's measured-size
after-turn split and admission backstop in 4.4.0. Those use the fresh-session
handoff without a model summarization call, independently of the known-cold
policy. Missing/estimated measurements, native compaction during that turn and
other runtime gates prevent an unsafe duplicate split; reported working status
defers the after-turn path, while admission remains the backstop. Turning off
known-cold compaction does not disable these size/recovery paths. Verified at
`2ec8c0e`: `runtime/actor.rs`, `runtime/recovery.rs`; details in the
[Claude](../../harnesses/harness-claude-code/SKILL.md#compaction) and
[Codex](../../harnesses/harness-codex/SKILL.md#compaction) guides.

Suggest changing the cap when the user's desired team size requires larger
top-level allocations; changing the hire grant when new hires repeatedly need
the same adjustment; changing the threshold when context pressure warrants a
different compaction point; and changing effort when the user wants a common
quality/latency preference for agents that inherit it. For the credit model,
see `orgtree-credits` (orgtree-working › team). For session behavior, see
`orgtree-context-and-compaction` (orgtree-working › runtime).

## Logo

Agents can also set/remove their own org's Logo with `orgtree_org_logo` when
their inherited Organization Logo tool switch is on (the default). It applies
immediately and records the agent/time/action in the existing undo history.
See `orgtree-tool-org-logo` (orgtree-working › team) for the tool and limits.

`screen:org-logo` is the Logo group at the top of Basic. Click the logo/pencil
to choose a static PNG, JPEG or WebP, at most **5 MiB and 16 million pixels**.
Animated/unsupported or invalid images are refused. The initial fallback is
the org name's initials. The logo appears as the org account picture in Hubchat.

Selection opens an oriented image preview and a square crop. Drag the square
to move it or a corner to resize; arrow keys move it, Shift+arrows resize it.
**Save logo** commits the crop independently; **Cancel crop** discards the
selection. **Remove logo** clears the stored image immediately. The engine
normalizes the crop to a bounded PNG; a failed read offers Retry, and a failed
save displays an error. Suggest this for recognizable org identity in Hubchat.

## Automatic saving and the charter exception

Basic fields, Hire defaults, Policies and Connections' external-inbox controls
save in place. Discrete choices commit immediately; text/numeric input waits
about 750 ms after the last edit. Only the edited field is sent, requests run
in order, and the menu stays open. Closing flushes pending ordinary edits;
it does not undo completed writes. Failed fields show an inline error and
Retry; returned warnings remain visible. Untouched fields follow server values.

Org charter has its own explicit **Save**. Editing it, leaving the field or
closing the panel never publishes it. Closing discards its unsaved text as
before. A charter Save includes its read revision, and does nothing if unchanged.
Read [orgtree-org-charter-md](../org-charter-md/SKILL.md) for restart and conflict effects.

Folder removal/RW-to-RO and permission-mode changes commit on the completed
click; folder changes can revoke existing grants and mode changes can
reconfigure agents. Ordinary unrelated edits never resend those fields.
Logo crop, Save as template, Connections memberships, Autonomy and Accounts
keep their own action controls. History remains read-only.

## See also

- `orgtree-credits` (orgtree-working › team).
- [orgtree-app-default-org-settings](../../app-settings/app-default-org-settings/SKILL.md).
- [orgtree-org-charter-md](../org-charter-md/SKILL.md).
