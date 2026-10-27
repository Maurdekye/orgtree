---
name: orgtree-app-notifications
description: Explain desktop notification kinds, defaults, focus suppression and the master switch.
---

Up: [orgtree-app-settings](../SKILL.md)

# Notifications

Runtime > Notifications controls native desktop alerts for every organization on this machine. Each switch saves immediately to native desktop preferences. Agents explain or suggest these controls; the user changes them. There is no agent restart, scope grant or prompt rewrite from changing an alert preference.

| Control | Storage | Default | Meaning |
| --- | --- | --- | --- |
| Open questions | `np:questionTarget` | focus the agent desk | Taskbar question entries focus the asking agent; an existing pin or popped-out desk comes to the front. Choose **Open questions as mail** to open the question in the inbox instead. Independent of banner switches. |
| Notifications | `np:notificationsEnabled` | On | Master gate. Off suspends all listed desktop alerts and disables their subordinate controls without erasing their selections. |
| Questions | `np:notifyQuestions` | On | Desktop question/request alerts. A click goes to the asker's desk when it is already open (below), otherwise to the inbox or the Attention queue. |
| Urgent mail | `np:notifyUrgentMail` | On | Mail marked urgent for the user. All mail also permits this kind. |
| Terminal failures | `np:notifyTerminalFailures` | On | Terminal-failure alerts. |
| Docket attention | `np:notifyDocketAttention` | On | Work-item attention alerts. |
| Mentions | `np:notifyMentions` | On | Plain @user mentions in agent replies, mail, presented documents or docket updates. Backticks/code spans and fenced code stay literal and do not create mention alerts. |
| All mail | `np:notifyAllMail` | Off | Routine mail alerts, and urgent mail even when its own toggle is Off. |
| New presented document | `np:notifyDocuments` | Off | A newly presented document's alert. |
| Agent frozen | `np:notifyFrozen` | Off | Agent-freeze alerts. |
| Notify while Orgtree is focused | `np:notifyWhileFocused` | Off | Permit alerts while an Orgtree window has focus; it is an additional gate, not a new event kind. |

The focus check considers any visible, non-minimized Orgtree window. With the default focus preference, such a focused window suppresses desktop alerts even if another organization is in the background. Suggest enabling it when the user wants alerts while working in Orgtree; suggest leaving it Off when in-app attention is sufficient.

Suggest individual kinds according to what the user wants to notice. All mail is a broad opt-in, not a requirement for Questions or Docket attention. Turning the master Off is appropriate when the user wants to pause desktop banners while retaining the underlying work and mail.

Native alerts have stable identities to avoid duplicate banners, and resolved attention removes corresponding native alerts where supported. The desktop closes pending/shown alerts for kinds disabled by a changed preference. OS support and native delivery still matter: the engine recording mail or attention does not prove a banner appeared, and a banner does not establish that the user read or approved it.

Clicking a question banner when the asking agent's desk is already open as a
floating desk (the Open desk modal or a popped-out desk window), a desk pin, on
a zoomed canvas card (the agent's own, or its panel on the zoomed switchboard)
or in the Attention agent desk brings that desk forward and focuses the question
card there. The inbox does not open and the Attention queue keeps its
selection. Open in more than one of these, the one holding the live desk wins.
Otherwise the click opens the question in the inbox, or selects it in the
Attention queue.

Clicking a transcript mention banner or taskbar entry keeps that notification's
mention and source-event identity. If the agent has since mentioned you again,
the newer mention remains unseen. Current tree metadata can fill a missing event
only for the same mention ID; a changed agent generation still blocks the jump.
If the clicked source is unknown or unavailable after bounded history loading,
the desk opens without centering another mention.

On Windows, the taskbar attention dot matches Hubchat: a red centre with a
light rim and no number. Its appearance does not change what needs attention.

The persistent taskbar/dock attention dot is separate from these banner
preferences. It follows unresolved questions, urgent mail, docket attention and
plain user mentions; ordinary unread mail and standalone terminal failures do
not add the dot. Focus does not clear it; resolving the underlying attention
does. Mention-only activation opens the relevant place rather than inventing a
question. Verified at `2ec8c0e`: `notifications.ts`, `taskbar-attention.ts` in the
desktop main process and `docs/rust-engine/taskbar-dot.md`.

Older preferences with routineNotifications enabled and no explicit notifyAllMail retain that routine-mail opt-in. Explicit current values take priority; absent current fields receive the defaults above. Read the saved preferences rather than assuming an older installation has every default value.

## See also

- `orgtree-reaching-the-user` (orgtree-working › user).
