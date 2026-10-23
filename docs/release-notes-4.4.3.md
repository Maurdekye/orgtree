# Orgtree 4.4.3

Orgtree 4.4.3 keeps an agent's unfinished reply visible when it is interrupted, makes project broadcasts reach only the project's own members, and makes it clearer where your sent message went.

## Agents and transcripts

- **Interrupted replies stay on screen.** If an agent is stopped, halted or interrupted while it is writing, the text it had already written stays in its transcript, marked as an incomplete response. Where the AI tool supports it, a later finished version of the same reply replaces it in place, also after a restart.
- `orgtree_read_transcript` marks such replies as incomplete or interrupted.

## Projects

- **A project broadcast reaches the project's members and stops there.** It goes to the agents directly in the project, and to agents in projects nested inside it, but no longer to those agents' own reports. The desktop broadcast and the agents' project tool use the same rule; the desktop broadcast still reaches at most 1,000 recipients.

## Desk

- **Send feedback such as "steering in mid-task" appears above the report and watchdog jump cards** in an agent's desk, between the conversation and those cards.

## First run

- **The last Getting started tip sits to the right of the message box**, so it no longer covers a file you have attached.

## Notes

- The user documentation in this repository covers the changes in this release.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
