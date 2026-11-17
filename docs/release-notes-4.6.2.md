# Orgtree 4.6.2

Orgtree 4.6.2 adds GPT-6.2 Sol and GPT-6.2 Astra, and makes switching desks on the canvas smoother: the graphics warm-up now runs on every launch, and the interface redraws far less while the org is busy. It also adds middle-click canvas controls, shows a remote computer's usage to org members, and runs Antigravity agents on a standalone engine. It still bundles Mail hub 2.4.0.

## Models

- **Sol 6.2 and Astra 6.2.** New Sol and Astra agents run GPT-6.2 Sol and GPT-6.2 Astra (`gpt-6.2-sol`, `gpt-6.2-astra`). Existing agents keep their model; pick 6.2 under **Model version** to move one. Both need a Codex CLI that lists them (0.166.0 does) and a signed-in OpenAI account that offers them.
- **Astra costs less.** New Astra seats cost 8 credits (was 10), following GPT-6.2 Astra's lower price. Seats already hired keep their price until rehired.
- **Argon is legacy when Carbon is offered.** When Gemini Carbon is available, Argon only shows with **Show legacy models** on. Without Carbon, Argon shows as before. Existing Argon agents are unaffected.

## Smoother desktop

- **Warm-up on every launch.** The hidden graphics warm-up now runs every time Orgtree starts: 15 seconds after launch, once you've been idle for 5 seconds, and at most 30 seconds later even if you're busy. Shaders kept on disk still cost time on their first use in each run, so this moves that cost to just after launch instead of your first desk switches. It also finishes on slower graphics cards and runs again if the shader cache is wiped.
- **Less redrawing.** Live org updates that change nothing redraw nothing, and an update to one agent redraws only that agent. Canvas cards and Quick chat rows remeasure only when their content or size changes. Open desks no longer rescan their messages on every update.

## Canvas and desks

- **Middle-click.** Middle-click an agent to focus it; double middle-click to fit the whole org. **App settings › Keyboard shortcuts** is now **Controls** and lists the canvas mouse gestures.
- **Coworker hire buttons stay reachable.** On a project card, at mini and normal zoom, the coworker hire buttons beside the card no longer vanish as the pointer moves from the card to them.
- **Popped-out desk header.** A narrow popped-out desk's header wraps onto a second row, so the status text no longer runs under the window controls.
- **Reordering into the last slot.** Dragging an agent into the last place among its siblings works even when the last sibling is retired.

## Remote orgs and engines

- **Usage for members.** When you open an org on another computer, the Usage panel shows that computer's usage once both computers run 4.6.2 (e-mail addresses stay hidden, and refreshing stays with that computer). If the other computer runs an older version, the panel says so; if usage can't be read, it shows the error instead of loading forever.
- **Antigravity on a standalone engine.** The agents image installs a pinned Antigravity CLI on first start (`-e AGY_INSTALL=off` skips it), and a file sign-in is checked with `agy models`.

## Notes

- No database changes.
- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.2`, plus the agents image `:4.6.2-agents`. These packages are optional: the desktop app doesn't need them.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
