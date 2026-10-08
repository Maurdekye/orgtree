# Orgtree 4.0.1

Orgtree 4.0.1 is a fix-and-polish release on top of 4.0.0. It adds optional Claude 5.5 models through Antigravity, shows queued changes on agent cards, makes upgrades from 3.x safer, and brings back several behaviours from 3.x around accounts, mail, permissions and credits.

## New

- **Claude Sonnet 5.5 and Opus 5.5 through Antigravity.** They appear as "sonnet (antigravity)" and "opus (antigravity)" and are off by default. Turn them on in App settings > Runtime.
- **"Next turn" cards.** When you queue an account, model or effort change for an agent that is working, its card now shows what will apply at the next turn (for example "next turn → opus"), with a tooltip that explains it. Several queued changes fit together on one card, and long names wrap instead of overflowing.

## Improved

- **Safer upgrades from 3.x.** Each organization is imported all or nothing. If one cannot be copied, nothing of it is kept, the organization's line in the list says what failed, and the import retries on the next start. An account you removed is not brought back by a retry. Data from older 3.2 test builds imports too.
- **Imported work keeps going.** Open questions imported from 3.x can be answered, credit and permission requests are kept, and an imported agent whose session cannot be recovered can be rehired on a fresh session.
- **Accounts and limits.**
  - An agent is never placed on an account whose limit it would spend is already at 100%.
  - Automatic account fallback moves an agent only onto an account with proven room, and a slow usage check can no longer leave an agent hanging.
  - Antigravity quota reset times are honoured, and OpenRouter shows a refused key right away.
- **Mail and agent turns.**
  - Failed requests are replayed after a limit is released, without a growing pile of re-sent mail.
  - A manager is told once per run of failures, and the wrong "Fable limit reset" notice is gone.
  - "Credential rejected" now says what to do.
- **Permissions and settings.**
  - Hires follow the 3.x rules for folders, tools and visibility.
  - Removing a folder from an organization, or making it read-only, updates its agents' grants.
  - Invalid settings are refused instead of stored.
  - What an agent can see follows its chain of managers.
- **Credits and organizations.**
  - A seat swap now charges only the price difference.
  - Credit decisions are worded correctly as approved, counter-offered, declined or reduced.
  - A cap of 0 means no cap.
  - Deleting an organization moves its folders to the trash.
  - Organization names follow the 3.x rules again.
- **Question cards.** Multiple-choice answers are complete, a dismissed card reads as dismissed rather than answered, and folder approvals report what was actually granted.
- **Document chips** beside an agent's node match the four shown in its desk header.

## Fixed

- The canvas no longer crashes when the window is resized right after opening.
- The engine no longer crashes or fails to start on unusual old data, an unusual log file name, an odd OpenRouter reply, or an unreadable old-data store.
- Automatic check-ins and ticket reminders work again.
- Cancelling a hire resets your focus immediately instead of after a short delay.
