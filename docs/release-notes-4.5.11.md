# Orgtree 4.5.11

Orgtree 4.5.11 adds a Files tab to desks, shows helper transcripts with their full context, adds a Fable pip to the Claude weekly meter, renames the first settings tab to General, and fixes several layouts on smaller screens. It still bundles Mail hub 2.4.0 and works with Hubchat 1.3.4.

## Desks

- **Files tab.** A desk shows a **Files** tab once a file has been delivered to it, listing each file with the same inline card the chat uses: images, video and audio play in place. The tab stays hidden while there are no files.
- **Audio plays in place.** Audio attachments show their player as soon as they appear, paused, like videos. The **Play audio** button is gone.
- **Helpers.** The number of an agent's helpers is now a badge in the desk header. A helper's transcript keeps the same row summaries as the desk (tool inputs, times and the text between tool calls) and keeps about 200 or more rows. A live helper transcript keeps following new lines until you scroll up.

## Settings

- **General tab.** The first tab of Agent, Org and Project settings is now called **General** (it was Charter, Basic and Project). Links and saved tabs still open the same tab, and settings search finds it by the new name and the old one.
- **Name and actions first.** Agent and Project settings show the name and the agent's actions in the General tab. History and Activity keep a usable minimum height, and on short screens the settings window opens nearly full height.
- **App settings** wrap their tab strip onto a second line instead of hiding tabs, the chosen-models box grows with its chips, and a long version number no longer pushes the header icons out of the card.

## Usage

- **Fable pip.** On a Claude account that has a separate Fable weekly limit, the weekly (all models) meter shows a small tick. Past that point the rest of the week's Fable allowance can no longer be used up before the weekly limit. It sits at (1 + Fable used) / 2 and moves with the Fable reading. Hovering it shows that point as a percentage of the weekly limit. It's hidden when the Fable reading is unknown or Fable is fully used.

## Smaller screens

- **Pinned desks** open at a desk's size and never shrink below their header and controls.
- The focused-desk and canvas-gutter changes tried in the 4.5.11 alphas were taken back out; the desk and canvas controls behave as in 4.5.10.

## Agents

- **Cold wakes after a Claude Code compaction** now use the context size Claude Code reports after compacting, so the cheap-compaction rule decides from a measured size instead of an estimate.

## Untested

- There was no hands-on test round of the final build; the user tested 4.5.11-alpha.2.
- Helper transcripts: resuming the live follow by scrolling back to the bottom, opening a long Read result and the saved transcript were checked by automated tests, not by screenshot.
- The Fable pip was checked with recorded usage readings, not on a live account during a week.

## Notes

- No database changes since 4.5.10.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
