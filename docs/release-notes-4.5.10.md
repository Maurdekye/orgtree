# Orgtree 4.5.10

Orgtree 4.5.10 adds Fable 5.2, lets you rename an org, shows language model servers' usage and real context sizes, and fixes the hire tools, project notices and user watchdogs on retired projects. It still bundles Mail hub 2.4.0 and works with Hubchat 1.3.3.

## Models

- **Fable 5.2.** The Fable tier offers Fable 5.2 (`claude-fable-5-2`). A new Fable hire that doesn't pick a version gets 5.2. Fable 5.1 and 5 stay selectable, and existing Fable agents keep the version they run: an agent with no saved version stays on 5.1, and its settings label that choice "default (5.1)". Moving an agent into the Fable tier without picking a version gives it 5.2. Fast mode is offered for Fable 5.2 only. Fable 5.2 needs Claude Code 2.1.321 or later.

## Organizations

- **Rename an org.** **Org settings > Basic > Name** changes the org's display name. Its id stays the same and is shown read-only. The new name is sent to every mail hub the org is registered with, so Hubchat contacts see it too (the first 48 characters).

## Language model servers

- **Model lists refresh by themselves.** A server's model list and model details refresh in the background, not only when you click refresh. Server cards start from the last known list.
- **Real context sizes.** Each model's context size comes from what the server reports, with no cap. A model whose server reports none is treated as 1M tokens. Older saved default sizes are upgraded.
- **Usage windows.** A server whose `/usage` route answers (OpenCode Go has its own preset route) shows its usage windows on the Usage card, the usage board and its route line. They're shown only; Orgtree doesn't stop agents at 100% for them. A server without usage shows no usage wording.

## Agents and tools

- **Hire tools on newer Claude Code.** `orgtree_hire`, `orgtree_rehire` and `orgtree_staff` now use plain object schemas, and their conditional rules live in the tool text. A hire that leaves out required fields gets told which ones are missing before anything else, instead of "unknown tier".
- **Outside mail before anyone holds the org inbox** now waits for the first holder and is handed over oldest first.
- **Claude usage readings** back off for at most two minutes after a failure, and a failed probe logs why.

## Notices and watchdogs

- **Project lifecycle notices** ("Project … was dissolved", retired and similar) show as formatted notice cards in agent chats and the inbox, like agent retirements, instead of plain text.
- **Your own watchdogs.** Clicking one of your own watchdog chips in the switchboard opens the project panel that lists it (listeners, slots or desk), including ones beyond the first eight. Retiring, dissolving or deleting a project now removes your registrations on it, and a start-up sweep clears ones left on projects that were already retired.

## Untested

- Fable 5.2 was tested by automated tests only. No real Fable 5.2 agent has run yet, so your first Fable 5.2 hire is the first real check that your accounts can use it.
- The rename push was tested against a test hub, not a real mail hub. Language model server refresh, context sizes and usage were tested with mock servers, not a live OpenCode Go account.
- There was no hands-on test round on an installed build of this release.

## Notes

- One database change: an index for outside mail waiting for an org inbox holder (migration 0085). It applies once on the first start, and an upgrade from 4.5.9 keeps every org's data. Going back to 4.5.9 afterwards is not tested.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
