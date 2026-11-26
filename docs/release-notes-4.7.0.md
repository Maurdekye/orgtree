# Orgtree 4.7.0

Orgtree 4.7.0 turns your Inbox into chats, like Hubchat. It also lets you export, import and duplicate agents, teams and projects, and gives you new ways to protect your organization's outside mail: blocking, lockdown and weak links. It bundles Mail hub 2.6.0.

## Your Inbox, as chats

- **The Inbox is now a list of chats**, like Hubchat. Every top-level agent and every agent you gave an audience has a chat, newest first, each with its unread count. Your mail, requests and audiences are the same as before; only the view changed. The Inbox button is now a chat bubble.
- **Closing a chat takes back that agent's audience**, at once and without a confirmation. Its mail is kept. A top-level agent's chat can't be closed, and the close button's tooltip says why.
- **New chat** slides the agents list out over the chat list. Picking an agent opens its chat and gives it an audience if it had none. A click outside the list closes it again.
- **The message box is the desk's**: the same buttons in the same places, Up and Down to recall what you sent, and your unsent text and files are kept per chat. The chat you had open is still open when you come back.
- **Messages show at once.** What you send appears straight away with a clock. If it can't be sent, it stays in the chat with **Retry** and **Discard** in its menu.
- **Drop files on a chat** to attach them. A picture or file sent with no text shows just the file, and the send button works with only a file attached, here and on the desk.
- **Files show their progress** on the message while they are being delivered.
- **Long chats stay quick to open**: the newest 50 messages first, older ones as you scroll up, with nothing jumping.
- **A reply's quote shows the original in the chat.** Right-click a message for **View in @agent's inbox** or **View in transcript**; in the transcript, the message or the line of the call that sent it flashes once as it arrives, only for that jump.
- **Your messages show when the agent has read them**: a grey check while it has not, a green check once it has.
- **A chat stays at its newest message** while you are at the bottom, for messages you send and messages you receive. Scrolled up, it stays put and a round button jumps back down.
- **Typing dots** while a Claude Code agent is writing to you.
- **Right-click a message** for **Copy selection** when text is selected, **Open link** and **Copy link** on a web link, and **Copy mention** in a chat's row and header menus.
- **A message you send from your chats or an inbox reply no longer sits under "queued / undelivered" on the agent's desk** after the agent has read and answered it.
- **`@ticket:` is how a ticket is mentioned.** Type `@ticket:` to list every ticket; picking one writes `@ticket:<org>/<slug>`, and so do Mention and Copy reference. `@item:` still lists tickets, and every older `@item:` mention keeps working and is shown as it was written. Agents are taught the new form, which changes each agent's instructions once, at its next start.
- **The @ menu knows the chat.** In a chat's message box, what that chat mentions is listed first. Everywhere, tickets are ordered by their latest status change.
- **Streamer mode covers the chats**: addresses and outside names are hidden in chat rows, headers, messages and quote cards.
- **Clicking an agent's name opens your chat with it** when it has an audience with you, anywhere in the app, also a name written in a message. Its desk is one right-click away (Focus).
- **Open › Chat in every agent and project menu**, on cards, list rows and links anywhere in the app. If it has no audience with you yet, opening the chat gives it one first, and the tooltip says so.
- **Focus clears the way.** Choosing Focus from an agent or project link closes the floating panels in front of the canvas, so the agent isn't hidden. Pinned and separate windows stay.
- **Reply to your own message**, walk the messages with Shift+Tab and Tab and reply with R, as in Hubchat, and press Escape to remove an attached file.
- **Questions and requests appear in the chat** of the agent that asked, one bubble per question with one submit. Notices have a thick dashed border, requests a small label, and files are chips.
- **An audience request is a new chat**, at the top of the list. Approve or deny it in the chat, or just write back, which approves it.
- **A project's chat is one thread.** Your message to a project shows whether it waits in the queue or which agent holds it, and that agent's answer appears in the same chat under its name. Reply on an agent's bubble to write to that agent, or follow up on your own message to reach the agent holding it. A project chat's message box has the desk's megaphone (Alt+B), which sends your next message to every agent under the project. A megaphone send shows in each member's chat and once in the project's chat, in teal.
- **Your follow-up to a project now reaches the agent already working on it.** Before, a second message to a project was always a new job for any listener.
- **Agents that reach you through a project sit under it** in the list, indented, and say **via** the project; **Acquire audience** at the top of such an agent's menu gives it its own. Closing a project's audience shows who would lose theirs and asks first when anyone would; every other close still acts at once.
- **Right-click a chat** for the agent's or project's full menu.
- **A menu stays open while messages arrive.** New messages, the typing dots and read checks no longer close a message's or a chat's menu; a chat at its newest message waits until you close the menu, then shows what came in.
- **Each chat has the agent's controls**: its name is a link to the agent, a gear opens its settings over the chat, and its fast mode and effort are in the message box.
- **Agents answer you by mail.** A new message you type in a chat tells the agent to reply by mail, so its answer shows up in the chat. A message you write on an agent's desk tells it to answer there instead.
- **Replying to a presentation or a ticket opens that agent's chat**, with your reply as the latest message. You can turn this off in App settings > Display > Mailbox.
- **Take back a message the agent hasn't taken yet** with the small × on its corner, as on the desk.
- **View in classic inbox and View in chat.** A chat message's menu opens it in the classic mailbox, selected. Your mail with an agent or a project, in the classic mailbox or an agent's mailbox, opens in its chat with **View in chat**, flashed. While the chats are on, clicking a mail link to such a mail opens it in the chat, and a mail link's menu offers both views. In every message menu the **View in …** entries sit together.
- **A notice's bell is crossed out** while notice sending is on, and the message box's dashes are wider apart.
- **Notices don't pop up.** A notice an agent sends you never raises a desktop notification; it waits, unread, in your chats.
- **Prefer the mailbox as it was?** Tick **classic** in the Inbox's title bar, or turn on App settings > Display > Mailbox > Classic mailbox. It brings back the previous panel and its mail icon on this computer. See [your Inbox as chats](https://github.com/Maurdekye/orgtree/blob/v4.7.0/docs/messages-and-work.md#your-inbox-as-chats).

## Mailboxes

- **Transfers is its own tab**, beside inbox and sent, in every mailbox that shows file transfers. It fills the window and loads older transfers as you scroll.
- **The user Inbox's record tab is gone.**

## Export, import and duplicate

- **Export an agent, a team or a project as one zip file.** Right-click a node and choose Export…: only that node, or it and everything under it. When it is finished the Save dialog opens by itself, in Downloads. The file holds its settings, charters, credits, scratch and team folders, full transcript and history, CLI session, documents, docket items and watchdog definitions. Files outside its folders are left out. Nobody is interrupted.
- **Import here…** creates what a file holds directly under the node you chose, in this or another organization. Before anything is created the dialog says in a sentence what is created and what it costs. A name that is taken is numbered, as a hire's is (alice becomes alice-2). Then you are back on the canvas: imported agents arrive idle and run when someone writes to them. Claude Code, Codex and OpenCode agents carry on in their own session; other agents start fresh with a handoff note.
- **Duplicate…** makes a second agent, team or project beside the first, with the same settings, credits, folders, transcript and documents. Its docket items, cost history and mail are not copied. An agent with nobody under it is copied at once, with no dialog.
- **Secrets stay in the file unless you say otherwise.** When an export finds passwords, keys, tokens or credential files, it stops, names what it found and where, and asks whether to keep them or export again without them. The new setting App settings > Runtime > Export and import > Strip secrets from exports (off by default) takes them out of every export without asking.
- **Saved grants are kept, and shrunk only when they don't fit.** When the credits that can be drawn are short, your import or duplicate takes spare credits away from the bottom up, from the top down or evenly. The dialog says how many are lost in all; which way is the new setting App settings > Runtime > Export and import > Shrink grants that do not fit. With cost bubbling on, your imports are not limited.
- **Undo** takes an import or a duplicate back as one step, as it does a hire.
- **Agents can do all three** with the new tools orgtree_export, orgtree_import and orgtree_duplicate, on themselves and the nodes below them only. Their imports are always limited by their credits, and need no approval from you.
- **Mail to another organization on this computer can carry files**, up to 256 GiB, so an agent can send a whole team to another organization, which imports it from the attachment.
- An export is limited to 256 GiB. An agent on a model this computer can't staff arrives retired, with its team.

## Outside mail

Blocking, lockdown and last seen need your mail hub on Mail hub 2.6.0 or later. On an older hub a block waits until the hub is updated, and while the lockdown is on, an older hub carries none of your organization's mail.

- **Block a contact.** In the org mailbox's **mailservers** tab and in Org settings > Connections, each contact has a small red blocked-sign button at the end of its row. One click blocks it, with no confirmation: the contact and your organization can't message each other, both ways, until you unblock it with the checkmark in the same place. Agents holding the org mailbox can block abusive senders too, with the new orgtree_block tool, and you get a notice when a contact blocks your organization.
- **Lockdown**, a last resort against a flood of new outside accounts. While it is on, only the addresses on its list reach the org mailbox; everyone else's messages are refused at the hub and they see a lock. Find it in Org settings > Connections > External org mailbox: **Org decides** (the default), **On** or **Off**. When you turn it on, your linked phone address is put on the list for you. Optionally, unlisted mail can be set aside to read one letter at a time instead of being refused. Organizations on this computer are never locked out.
- **Org decides.** Outside communication (open or closed) now also has an Org decides choice, the default: the agents holding the org mailbox open or close it. Your own choice of Normal, Do not disturb or Closed still wins.
- **Weak links.** An agent with a weak link to the org mailbox can write to outside contacts as the organization, while new outside mail still goes to the holder. Only replies to mail it sent come back to it. Its line to the mailbox tile has long dashes.
- **Failover.** When no holder can receive mail (halted, frozen, retired or none), the weak-link agent with the oldest link that can run stands in as the **acting holder** until a holder is back. The org mailbox tile and the canvas line say who is acting.
- **What a drop on the org mailbox does** is a new setting, App settings > Runtime > Org mailbox: make the agent the holder (the default), ask each time, or add a weak link. While you drag an agent over the tile, a label says what dropping it will do.
- **Last seen.** Your organization tells its mail hub when it was last active, so people using Hubchat 1.4.0 can see when it was last active. It is the newest turn of the agents in charge of the org mailbox, and it never goes back.

## Agents and teams

- **Agents can read a seat's effort.** orgtree_state_inspect shows the effort each agent's turns use and where it comes from (set on the seat, the org's default, the built-in default, or not supported by the model), and the chart shows it next to the tier, for example `opus (medium)`.
- **Coordinators hand off slow work.** The coordinator charters that ship with Orgtree tell a coordinator to give anything that might take over 10 seconds, including queries and searches, to a report, so it stays free to answer. A charter preset you never edited is now updated with the app, as the built-in templates are; an edited one stays yours.
- **Gemini 4 Neon's seat costs 3 credits** (it was 2).
- **A project's audience notices name the project**, instead of reading as its manager's own audience.

## Usage

- **The Claude weekly bar shows Fable's share.** On a Claude account with a Fable limit, the part of the weekly bar estimated to be Fable is a lighter shade, as in the Claude console. Hover either part for its approximate percentage.

## Notes

- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.7.0`, plus the agents image `:4.7.0-agents`. These packages are optional: the desktop app doesn't need them.
- Antigravity on a standalone engine: a real sign-in on a Linux engine still hasn't been checked.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
