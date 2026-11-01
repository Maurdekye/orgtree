# Orgtree 4.5.3

Orgtree 4.5.3 shows when an org or a person is busy or on Do not disturb, adds one set of instructions that every agent in every org receives, lets one phone link hold in all your orgs, turns mail references into named links that show when a message is unread, and makes settings saves and effort changes quicker. It bundles Mail hub 2.3.0.

## Before you upgrade

- **The bundled mail hub's upgrade is one-way.** Mail hub 2.3.0 upgrades its database on first start. After that, an older hub cannot open it: if you host the mail hub on this computer and go back to Orgtree 4.5.2 or earlier, the hub does not start and reports that its database is newer than it understands. To get it running again, install Orgtree 4.5.3 or later again, or restore a backup of the hub's data taken before the upgrade (mail that arrived after that backup is lost). Orgtree does not take this backup for you, so make one first if you might want to go back.
- **Going back means linking your phone again.** The Connect your phone note moves out of each org's charter into the new Instructions for all orgs, once, at the first start of 4.5.3. Orgtree 4.5.2 and earlier only read the note from the org charter, so after going back, link your phone again.
- **Each agent's first turn after the upgrade starts without its prompt cache.** Every agent's standing instructions change once in this release (they now learn about mail links, and they gain a place for the new Instructions for all orgs). That first turn costs more tokens and takes a little longer; later turns are cached as before.

## Busy and Do not disturb

- **Busy shows as an amber dot.** An org shows busy to the hubs it is connected to while none of its org-inbox holders can start a turn: there are none, every one is halted, frozen or retired, or Stop all is on. It is online again within a few seconds of one holder being able to run. Mail sent to it while busy still arrives and waits.
- **Do not disturb shows as a red dot.** An org whose outside mail is set to Do not disturb (Org settings > Connections > External org inbox) shows Do not disturb, even when a holder could run.
- **People's presence follows Hubchat.** A person who hasn't had Hubchat in front on any device for an hour shows busy, and a person who picks Busy, Do not disturb or Invisible in Hubchat shows that way here too. Invisible looks exactly like offline.
- **Connections sort by availability.** Online contacts come first, then busy, then Do not disturb, then offline. Hovering a dot or a contact link says which. Hubs older than Mail hub 2.3.0 report neither busy nor Do not disturb, so their contacts show online.

## Instructions for all orgs

- **One set of instructions reaches every agent in every org.** App settings > Runtime > Instructions for all orgs edits a block that every agent receives, on every provider, just before its own org's charter. It works like the org charter's editor: Save, a warning when the text is too long, and a refusal if someone saved a newer version first. A save restarts each agent's session at its next turn, never mid-turn.
- **One phone link holds in every org.** Connect your phone now writes its note into Instructions for all orgs, so agents in all your orgs, including new ones, recognise your phone. The phone panel says so. The note is ordinary editable text there; Unlink still takes it out, from there and from any org charter.
- **Templates never carry the phone note.** Exporting an org as a template drops it, and importing a template that has one drops it with a warning.

## Agents and settings

- **Changing a Claude agent's thinking effort no longer restarts it.** The new level reaches the agent at once, working or idle, and it keeps its session and cache. An agent whose program has stopped or doesn't answer is restarted at the new level, as before.
- **Saving agent settings is quicker.** One press of Save applies the change and closes the dialog. While a save is in progress the button says Saving... and ignores a second press. When a save does restart an idle Claude agent, the new session starts in the background, and mail that arrives meanwhile starts its turn without waiting.
- **Pick a harness when hiring.** The hire dialog's Model tab has the same Harness row as an agent's settings, and a manager agent can change a report's harness (an agent cannot change its own).
- **Change notices say what changed.** A settings notice in a transcript or the inbox names exactly what changed on one line: folders, tools, effort, account, harness and so on, with longer changes folded beneath it and instruction changes shown as a diff. A save that changed nothing writes no notice. Audiences, credits, model switches, renames, moves, hires and retirements read the same way.
- **Rescind is not offered for top-level agents.** It only appears for an agent that has a superior.

## Mail links

- **A link to a message is named by the message.** It shows the mail icon and the start of the message, opens that message in its mailbox, and has Open, Copy message text and Copy reference in its menu. It replaces the small open buttons after mail in agents' transcripts and in project listener tables. Agents are now told they can write these links.
- **Unread mail links are marked.** A link to a message its recipient hasn't read, yours or an agent's, has a coloured edge on its left that clears once it is read. Unread urgent mail has an orange edge.
- **App and panel links show whether they are running.** A running app or panel link has the accent-coloured edge; a stopped one has a dark grey edge. Apps list rows are tinted the same way.
- **Links no longer stretch their line.** A link of any kind in running text sits on the line's baseline and doesn't make the line taller.
- **Mail that mentions you has a faint tint**, instead of a fill that looked like a selected row.
- **Received org inbox mail names each agent "as @org"**, the way the Sent tab names its sender. That list stays inside the org.

## Chat and composer

- **Videos open in place.** A video in a chat shows its first frame as soon as its card is on screen, without playing; its own controls play it, and its fullscreen button maximizes it.
- **The image viewer zooms only the picture.** Pinch, or hold Ctrl and use the mouse wheel, to zoom up to 6x; drag to move; double-click to switch between fit and 2.5x. Letting go doesn't close the viewer, and closing it always leaves the app at its normal size.
- **Message history keeps your draft.** Pressing Up into your sent messages sets the draft aside; Down past the newest message or Escape brings it back exactly, even after you leave the desk and return. Edits to a recalled message are kept while you browse.
- **Up and Down follow wrapped lines.** Up enters message history only from the top visible row of the message box, and Down only from the bottom row.
- The hint for a kept draft now reads "press down / esc to return to your draft".
- Durations read 250ms and 30s, with no space before the unit, everywhere including the engine debug panel.

## Requests and cards

- **Answered requests fold long questions.** A long question in an answered request card folds like a long message; click to expand. Options and picks stay visible.
- **An answer looks final as soon as you send it.** The card shows the offered options and your picks from the first moment, instead of changing when the server confirms it. Answering a question linked to docket items no longer shows "Unsupported message format" for a moment.
- **An expanded answered question stays expanded** when the server's copy replaces the one you just sent.

## Projects and canvas

- **Retired agents' listeners are hidden.** A project's listener lists and the canvas's listener lines no longer show a retired agent's paused listeners. Nothing is deleted; rehiring the agent brings them back.
- **Opening an org fits around pinned windows.** The first zoom to fit the whole org now also leaves room for a pinned window that appears just as the org opens, and keeps following as pinned windows are resized.
- **Busy dialogs can't be closed from their title-bar menu.** While a dialog is saving, Close in its title-bar menu is greyed out, like its X.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
