---
name: orgtree-app-notifications
description: Explain desktop notification kinds, defaults, focus suppression and the master switch.
---

Up: [orgtree-app-settings](../SKILL.md)

# Notifications

Runtime > Notifications controls native desktop alerts for every organization on this machine. Each switch saves immediately to native desktop preferences. Agents explain or suggest these controls; the user changes them. There is no agent restart, scope grant or prompt rewrite from changing an alert preference.

| Control | Storage | Default | Meaning |
| --- | --- | --- | --- |
| Notifications | `np:notificationsEnabled` | On | Master gate. Off suspends all listed desktop alerts and disables their subordinate controls without erasing their selections. |
| Questions | `np:notifyQuestions` | On | Desktop question/request alerts. |
| Urgent mail | `np:notifyUrgentMail` | On | Mail marked urgent for the user. All mail also permits this kind. |
| Terminal failures | `np:notifyTerminalFailures` | On | Terminal-failure alerts. |
| Docket attention | `np:notifyDocketAttention` | On | Work-item attention alerts. |
| All mail | `np:notifyAllMail` | Off | Routine mail alerts, and urgent mail even when its own toggle is Off. |
| New presented document | `np:notifyDocuments` | Off | A newly presented document's alert. |
| Agent frozen | `np:notifyFrozen` | Off | Agent-freeze alerts. |
| Notify while Orgtree is focused | `np:notifyWhileFocused` | Off | Permit alerts while an Orgtree window has focus; it is an additional gate, not a new event kind. |

The focus check considers any visible, non-minimized Orgtree window. With the default focus preference, such a focused window suppresses desktop alerts even if another organization is in the background. Suggest enabling it when the user wants alerts while working in Orgtree; suggest leaving it Off when in-app attention is sufficient.

Suggest individual kinds according to what the user wants to notice. All mail is a broad opt-in, not a requirement for Questions or Docket attention. Turning the master Off is appropriate when the user wants to pause desktop banners while retaining the underlying work and mail.

Native alerts have stable identities to avoid duplicate banners, and resolved attention removes corresponding native alerts where supported. The desktop closes pending/shown alerts for kinds disabled by a changed preference. OS support and native delivery still matter: the engine recording mail or attention does not prove a banner appeared, and a banner does not establish that the user read or approved it.

Older preferences with routineNotifications enabled and no explicit notifyAllMail retain that routine-mail opt-in. Explicit current values take priority; absent current fields receive the defaults above. Read the saved preferences rather than assuming an older installation has every default value.

## See also

- `orgtree-reaching-the-user` (orgtree-working › user).
