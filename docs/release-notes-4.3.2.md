# Orgtree 4.3.2

Orgtree 4.3.2 improves agent recovery, shared skills and everyday status information. It also preserves watchdog schedules across restarts, makes usage history easier to navigate, and fixes session notices, conversations and docket interactions.

## Agent instructions, skills and recovery

- **Shorter built-in instructions** direct supported agents to the Orgtree skill library for detailed guidance. Standing notes remain separate, including in Antigravity, so longer notes do not crowd out the core rules.
- **Skills match the receiving harness.** When a guide has several harness-specific versions, Orgtree selects the appropriate one instead of supplying all variants. Claude imports also avoid skills already supplied by its native profile and enabled plugins.
- Old exported skill snapshots are cleaned up while copies still needed by running processes or resumable sessions are retained. Your original skill files are left intact.
- **Fresh-session recovery keeps more useful context:** current work, blockers, dependencies, recent instructions from the superior, and the last recorded shell directory. Saved history retains actual shell commands where available, with explicit clipping for long inputs, and labels each sender in a batch of messages.
- Hiring tools describe their required fields more clearly and report missing fields together, including placement and scope choices.
- Brief interruptions in the Windows sign-in helper no longer produce false sign-out and sign-in notices. Waiting agent mail is delivered automatically when the helper reconnects.

## Agent status, conversations and docket

- **Hovering an agent name shows its model and effort** in the native tooltip, including in pop-out windows. The account is included when that provider has several configured accounts; draft and retired agents are identified appropriately.
- Halted agents show how long they have been halted in desk headers and nearby canvas cards. Far-zoom cards use a compact halt icon.
- **Markdown images can appear inline** in chat and mail from local files or web URLs. Local image embeds only load regular files from local drives. PNG, JPEG, GIF and WebP images are checked before display; unavailable or unsupported images retain a link fallback, including in pop-out windows.
- Local file attachments in agent mail no longer show garbled names.
- Replies on a docket item default to the agent who raised its attention flag when one is present. Opening an item needing attention scrolls to its detail and reply area, and agent actions work from the reply-recipient menu.
- The inbox no longer shows the redundant Add to reply link.

## Usage history and monitoring

- **Usage history keeps its controls visible** in a compact sticky header. Filters have their own row, and account choices include the provider's name.
- Switching the history period keeps the previous charts in place, dimmed, until the new data arrives. Scroll position is preserved, and shorter time ranges keep their time-axis labels.
- **Rate-limit recovery respects provider reset deadlines**, including relative countdowns and reported reset times, instead of falling back to an early retry against an expired deadline. Recovery continues to respect the automatic-resume setting.
- **Watchdog countdowns** show when a polling watchdog is due to check next. Long waits use readable hours or days, and silence-watch deadlines update when their baseline changes.
- **Watchdog schedules survive restarts.** If a check was missed, the watchdog checks once on startup, then keeps its original rhythm rather than restarting its interval. Silence watches check for fresh activity before sending an overdue quiet notification.

## EPIC Mode and built-in guides

- EPIC Mode removes the combo meter and rank fanfare. Usage effects track each account's own limit window so repeated readings do not replay the same crossing.
- The built-in glossary adds suggested committee and development-team workflows. Its guides also clarify mail delivery, docket access, Windows shell pitfalls and UI testing without an interactive desktop.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
- Muse write agents running in the Windows background session still run without Muse's OS sandbox. Hosted Muse agents use its sandbox in the signed-in session. Harness capabilities and model availability continue to differ by account and platform.
