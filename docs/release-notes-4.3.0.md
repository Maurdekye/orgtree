# Orgtree 4.3.0

Orgtree 4.3.0 brings Muse Code, Wonder and Wonder Full to the public release, along with Gemini 4 Argon through Antigravity. It also shares skills and personal instructions across harnesses, adds persistent undo and redo, and gives Windows users a choice of where the background engine runs.

## Models, accounts and usage

- **Muse Code support** includes Wonder, Wonder Full and Spark, model and effort selection, structured conversations and tool activity, session resume, steering and Orgtree tools. Models come from the selected account's catalog; Wonder Full is offered only when that account has access.
- **Gemini 4 Argon through Antigravity** is selectable when the signed-in account's model list offers it. Conditional models are no longer offered merely because Orgtree knows their names.
- **Several OpenRouter keys at once**, with a label, activation switch, usage reading and harness choice for each key, including OpenCode when installed. Every key is treated alike, and harness selection reflects what is installed.
- Muse keeps its dated last-good usage reading across engine restarts. After a reset it shows that a new reading is awaited rather than inventing a zero. Short Claude usage rate limits are treated as a wait, and simultaneous refreshes share one request.

## Shared skills and instructions

- **Skills sharing across supported harnesses**, including skills from installed Claude Code plugins. Source labels and Refresh make imported skills easier to inspect and update.
- **Imported MCP tools** can use server definitions discovered from installed harnesses and Claude Code plugins, with visible sources and refresh controls. Per-agent tool limits still apply.
- **A built-in Orgtree skill library** gives agents guides to the app, its tools, settings, workflows and harnesses. Guides are loaded through the shared skills system rather than putting the whole library into every prompt.
- **Personal global instruction files are shared across harnesses**, including isolated account profiles. Files the current harness already reads are not delivered twice. Original files are left intact, and updates take effect when the agent next starts without changing a running turn.

## Organizing work and conversations

- **Persistent undo and redo** for your own move, hire, retire and supported agent-settings changes. Each organization keeps up to 100 history entries across restarts. Use Ctrl+Z or Cmd+Z to undo, and Ctrl+Y or Ctrl+Shift+Z / Cmd+Shift+Z to redo; text editors keep their own undo. Conflicting changes can be refused, and very large retirements are not undoable. Agent tool actions are not added to your history.
- **Multi-replies** collect several messages within one conversation, including messages by different authors. Reply adds a target, individual targets can be removed, and one send carries the linked replies together.
- **Simpler message kinds:** Message and Question. Existing message content is retained. The external organization inbox is a viewer; Hubchat is the human client for hub mail.
- **Consistent docket menus** bring transcript ticket actions to docket rows, alongside their ticket-specific controls. Alt+Up/Down steps through documents and docket items while respecting editors and open questions.
- Clearer theme preset names and ordering, with the revealed Rainbow option limited to Custom themes. Optional **EPIC Mode** adds animated effects and sound to work and interactions; it stays dormant while switched off.

## Windows startup and recovery

- On **all-users Windows installations**, Desktop settings can run the background engine **at sign-in, in your session**, or **at boot, before sign-in**. Boot remains the default. Changing the choice asks for Windows permission; a running engine keeps running until restarted or the next applicable startup.
- Core components recover independently after a failure while deliberate Quit remains respected. Restoring several organization windows after restart now reveals all of them.
- Installer shutdown can ask a background engine to stop even when the usual desktop connection is unavailable.

## Fixes and polish

- Streaming thoughts no longer collapse into a thin strip in long conversations. Tool clocks stop following an unrelated running turn, and file/document cards separate delivery details from tool timing.
- Antigravity's own standing notes are preserved, and tool activity stays ordered around delivered mail.
- Oversized mail remains available by reference instead of overflowing a turn's input. Deferred mail keeps its order.
- Better canvas drag previews and middle-button panning, clearer provider headings, wider settings tabs, and more consistent document and inbox layouts.

## Bundled mail hub 2.2.0

The bundled hub adds profile pictures, structured message metadata for question cards and linked replies, typing heartbeats, and clearer refused-send logs. These features are also available to standalone hub operators in mail hub 2.2.0.

**Hub operators: back up both the database and attachment-data volumes before upgrading.** First start applies schema 10. A 2.1.x hub cannot open that migrated database; rollback requires the pre-upgrade backup and does not retain later mail. See [mail hub upgrade and backup instructions](https://github.com/Maurdekye/orgtree-mailhub/blob/v2.2.0/docs/OPERATIONS.md#upgrades).

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes; automated builds and smoke checks do not replace testing on your own machine. Downloads include `SHA256SUMS.txt`.
- Harness capabilities and model availability differ. Muse's real additional-account, API-key and image paths still have verification gaps, and missing usage or cost information remains unknown.
- **Muse write agents under the Windows boot-session engine run without Muse's OS sandbox.** In that posture its file tools can write outside the granted folders without asking Orgtree. The sign-in engine option provides an alternative to running the engine in that background session.
- Final combined checks found no new product regression, but existing automated test failures and environment-skipped Windows lifecycle checks remain. The separate scripted release gate was not rerun after those combined checks. Short timing samples do not establish a performance guarantee.
