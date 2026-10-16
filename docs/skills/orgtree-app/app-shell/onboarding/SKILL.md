---
name: orgtree-onboarding
description: Follow homepage onboarding and the new-organization canvas guide.
---

Up: [orgtree-app-shell](../SKILL.md)

# First run

Homepage onboarding appears when preferences have loaded, onboarding is not complete, and the known organization list is empty. An existing or imported organization suppresses it. The flow introduces appearance, Run on boot (Run on sign-in where Orgtree cannot start at boot), and Exit on close, then organization creation. Those choices use the same native preferences as App settings.

Finishing or skipping first populates the starter charter documents and then marks onboarding complete. If population fails, the flow exposes the error and can be retried. Creating an organization and completing this preference update are separate steps, so inspect a reported failure before recreating an organization that already exists.

The canvas first-use guide is started explicitly for a newly created organization. Its steps point at the real controls: choose the hire token, name and hire an agent, then send the first message. A template that already hired agents begins at the message step. Progress is kept locally; merely visiting an older empty organization does not restart this guide.

The guide follows visible controls and yields when a targeted control is obscured or unavailable. Use the actual highlighted action rather than searching for a separate synthetic Next operation. Onboarding is an introduction, not evidence that a provider account is authenticated or every harness is ready.

## See also

- [orgtree-homepage](../homepage/SKILL.md)
