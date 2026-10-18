---
name: orgtree-quick-chat
description: Hire and start a new agent through Quick chat and its model, effort, superior, and attachment controls.
---

Up: [orgtree-app-shell](../SKILL.md)

# Quick chat

Quick chat creates a new agent from the message and focuses its desk. It does not send to an existing agent. The name preview comes from the message's words; this hire supplies no charter. Enter submits the single-line field, excluding IME composition.

Use the model control to choose an offered model, the effort control to choose an explicit effort or the organization default, and the superior picker to choose top level or a live agent. The files control lists attachments and allows removal; drag/drop and pasted files also add attachments. With no offered model, sending reports that problem.

Each choice uses this organization's last manual selection first, then its template defaults. Model and effort can additionally fall back to the last choice elsewhere. A superior cannot carry across organizations. With no usable model history, the preference order is Opus, Sol, Argon, Wonder, then the first hireable model. Eligibility uses the hire picker's configured providers and compatible accounts, excludes accounts at 100% in a window that model spends, and checks the selected superior's credits, normal hire cascade and top-level grant cap. An eligible alternate account is carried into the hire. An unavailable remembered model is retained in memory so it returns when eligible again; using a fallback does not replace that memory until a hire or manual choice. Automatic model fallbacks follow the default effort; a compatible remembered/manual model keeps its effort selection. An unavailable remembered superior falls back to top level.

The selected top-level superior and its option row share the switchboard eye to the left of “top level”, with the same size, colour and spacing. Agent superiors keep their model cards.

Without attachments, the kickoff accompanies the hire. With attachments, the agent is hired first, files upload, and the kickoff is then sent with successfully uploaded paths. A later upload or message failure can leave the agent hired; inspect the reported partial outcome before trying again.

App Display settings choose whether this control appears at the top or bottom. In Attention view it is presented as New chat; the same new-agent behavior applies.

## See also

- [orgtree-app-display-input-and-startup](../../app-settings/app-display-input-and-startup/SKILL.md)
