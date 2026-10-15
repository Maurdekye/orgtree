---
name: orgtree-org-history
description: Explain the org's retained-record browser, filters, paging and document access.
---

Up: [orgtree-org-settings](../SKILL.md)

# History

**Org settings > History** is `screen:org-history`, a read-only browser of
retained records. It has no setting to save. The footer belongs to other tabs;
opening a record does not undo or replay an operation. Agents may suggest
looking here when the user needs older org records.

**Records** selects a collection. It starts on **Read user mail**. An **Agent**
selector appears for collections that need one; it offers live and archived
(non-deleted) agents, with the state shown for non-live agents. The server
returns at most 2,000 selectable agents, live first, then by name.

| Collection | Agent required |
| --- | --- |
| Chat transcript | Yes |
| Agent mail | Yes |
| Read user mail | No |
| User sent mail | No |
| Organization mail | No; omitted while the org inbox is disabled |
| Notices | No |
| Presented documents | No |
| Organization events | No |
| Turn errors | Yes |
| Watchdogs | No |
| Turn usage history | Yes |

Entries are newest first. **Older** follows the next cursor; **Newer** goes
back through pages already visited. The UI requests 50 records per page and
shows a total and page number. **Refresh** starts again at the newest page;
changing collection or agent also resets paging. Loading, empty collection,
no-agent and request-error states are shown explicitly. The endpoint clamps
page limits to 1–200 and refuses unknown sections or absent selected agents.

Expand a row to read its body/answer/details. Presented-document rows offer a
download and, for HTML documents, the preview opener. The browser says records
are kept until manually removed; this tab provides no remove control. The
collection labels are UI names, not a guarantee of additional filtering: for
example the current Read user mail query selects user-recipient mail rows
without a read-state predicate.

Suggest History for retained mail, activity, documents or usage context.
Use the separate undo history for reversing supported actions; see
[orgtree-toasts-and-undo](../../app-shell/toasts-and-undo/SKILL.md).

## See also

- [orgtree-toasts-and-undo](../../app-shell/toasts-and-undo/SKILL.md).
- [orgtree-org-policies-inbox](../org-policies-inbox/SKILL.md).
