---
name: orgtree-org-basic
description: Explain the org logo, credits, context threshold, effort and shared Save button.
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
| top-level grant cap | `org:max_top_grant` | 1,000 | Bounds increases to a top-level agent's grant. Lowering it preserves existing grants above the cap and returns a warning naming them. UI minimum 1, step 1; storage also supports 0 as uncapped, although this form omits a zero cap when saving. Negative values are ignored. |
| default top-level grant | `org:default_top_grant` | 20 | Prefills a new top-level hire's grant. UI minimum 0, step 1. Changing it does not reallocate existing grants. Negative values are ignored. The UI fallback is 50 when the field is absent; that is not the engine default. |
| compaction threshold | `org:compact_at` | 80% | UI 50–95%, step 1; the endpoint refuses percentages outside that range. Stored as a percentage and exposed to the renderer as a fraction. Claude Code receives the automatic-compaction percentage at process start; Codex receives the corresponding context token limit. A running process retains its launch threshold until replaced. Antigravity has no corresponding threshold setting. |
| default thinking effort | `org:default_effort` | empty saved value | Agents without their own effort use the org default on subsequent turns. The menu offers CLI default (no flag), low, medium, high, xhigh and max. The engine accepts the catalog's additional none/minimal names as well; unknown names are refused. |

The empty effort option is labelled **CLI default (no flag)**, but the current
engine's `effective_effort` resolves an empty level to **high** before launch.
Treat the label as a UI/source discrepancy, not a promise to omit effort.
Each harness/model maps the effective level to its supported names; an
agent's explicit level takes precedence. No rehire is needed. Do not promise
an immediate mid-turn effort change from this org control.

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

## One footer Save, several independent actions

Basic fields, Hire defaults and Policies are buffered together. Tab changes
preserve these edits; close/reopen discards the local buffer. Unedited setting
fields follow new server values. **Save** sends settings, a loaded editable
org.md, and (only after editing Hire defaults) the hire-default requests.

These requests are separate writes, run together, rather than one transaction.
If one fails, another may already have succeeded; read the displayed error and
reload/check current values before repeating. A successful save clears the
edit buffer and closes the panel; **cancel** closes it without submitting the
buffer. Org.md has its own revision check and restart effects: read
[orgtree-org-charter-md](../org-charter-md/SKILL.md), including when Save writes
an already-loaded charter the user did not edit.

Logo controls, Save as template, Connections, Autonomy and Accounts use their
own immediate actions. History only reads records. The footer does not defer
those actions or undo them when the panel closes.

## See also

- `orgtree-credits` (orgtree-working › team).
- [orgtree-app-default-org-settings](../../app-settings/app-default-org-settings/SKILL.md).
- [orgtree-org-charter-md](../org-charter-md/SKILL.md).
