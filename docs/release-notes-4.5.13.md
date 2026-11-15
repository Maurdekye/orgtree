# Orgtree 4.5.13

Orgtree 4.5.13 adds the Gemini Hydrogen and Krypton tiers, lets you hide either side of the Attention view by dragging its divider to the edge, checks for the Visual C++ runtime during Setup, and fixes popped-out desks, long-thinking Antigravity turns and hires whose folders their superiors lack. It still bundles Mail hub 2.4.0 and works with Hubchat 1.3.5.

## Models

- **Gemini 4 Hydrogen.** A new Antigravity tier (letter H, near-white). It costs 1 credit, offers medium and xhigh effort, and shows an estimated spend marked "est.". It is always offered; a turn the account can't run fails with a plain reason.
- **Gemini 4 Krypton** replaces Gemini Barium (letter K, pale lavender).
- **Flash is a legacy tier.** It is listed under **Show legacy models**.
- **Carbon** costs 4 credits, offers medium effort, and leads the Gemini group in model lists.
- **Fable** costs 8 credits. Seats hired at the old cost keep it until they are rehired.
- **Templates.** The Antigravity team runs on Hydrogen and Carbon. devteam (Claude) gains a Fable implementer and Heavy dev shop a Fable developer. Built-in templates you haven't edited follow the app's updates.

## Attention view

- **Hide a panel.** Drag the Attention divider to either edge to hide that side; drag it back to show it again.
- **Swap panels.** A button on the divider swaps the two sides. Pressing the divider or its button is a click (swap) or, after moving 4 px, a drag. Right-clicking the button opens the divider's menu, which now has **Reset to center**.

## Desks and windows

- The temporary agent desk opens in the same frame as the app's other modal panels, and can be pinned or popped out from there.
- With the Attention desk popped out and the main window closed, an agent link opens in that desk.
- A panel pinned in a popped-out window stays in that window.
- After an update with a desk popped out, the main window's "restored desk" view returns to the canvas again when you click **Return to canvas**.
- A node's model tag no longer stays on a card that has become a desk.

## Turns and reports

- **Longer silence limit.** A turn is stopped for producing nothing after 30 minutes by default, instead of 10. This lets long-thinking Antigravity (Carbon) turns finish.
- **Antigravity context summaries.** When Antigravity's own context summary stalls, the turn is retried once in a fresh session. Antigravity contexts are reset at 230k tokens.
- **Stalled reports.** A report that stalls again after a deliberate wake raises a new alert instead of staying silent.

## Setup and hiring

- **Visual C++ runtime.** Setup checks for the Visual C++ runtime the bundled PostgreSQL needs. When it is missing or too old, Setup downloads Microsoft's redistributable, runs it only if Microsoft signed it, and checks again; Windows asks for administrator approval. Setup never stops because of this: if the runtime can't be installed, it warns you with the download link. If Windows ends the database at start for a missing runtime, the error names it.
- **Hiring with a folder the superior lacks.** A hire created with a folder its superior doesn't hold now grants that folder up the superior chain, instead of being refused.

## Untested

- The final release build wasn't run hands-on before publishing. The user tested these changes in 4.5.13-alpha.2 and 4.6.0-alpha.1, which contain the same code apart from the version number.
- The Visual C++ runtime check was tested with fixtures. A real download and install on a PC that lacks the runtime, and its approval prompt, weren't tried.

## Notes

- No database changes since 4.5.12.
- The standalone (headless) engine ships again as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.5.13`, plus the agents image `:4.5.13-agents`. These packages are optional: the desktop app doesn't need them.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
