# Orgtree 4.5.2

Orgtree 4.5.2 lets you choose the harness of an OpenRouter or language model server agent, makes the org inbox sturdier and clearer, lets request cards fold away, and brings Orgtree's panels, lists and contact marks in line with each other and with Hubchat.

## Agents and harnesses

- **Pick an agent's harness in its settings.** An OpenRouter or language model server agent's Model tab has a Harness row next to Model and Thinking effort. Leave it on "Follow key" (or "Follow server") or choose another installed harness; the agent moves at its next turn, on a fresh session that starts with a summary, and its transcript says why. Harnesses that are not installed, or that the server cannot carry, are greyed out with the reason.
- **A language model server's harness can be changed after setup.** Its entry in Providers now lets you edit the harness, instead of fixing it when the server is added.
- **Unrestricted Codex agents are never asked for permission.** A Codex agent with full access no longer raises approval prompts for tools, and that includes computer use on any app.
- **Stricter models accept Orgtree's tools.** Every Orgtree tool definition now states its types explicitly, so providers that validate tool schemas strictly (such as Kimi models on Claude Code) no longer reject them.
- **OpenCode agents show their thinking as it streams.** Thinking builds up live in the preview and is saved as one thought when it ends, instead of arriving in fragments.

## Mail and the org inbox

- **One bad message no longer stops the window.** A mail row or reading pane that cannot be displayed now shows an error in its own place; the rest of the mailbox keeps working. Before, it could replace the whole app with "Orgtree hit a problem and had to stop".
- **Org inbox links open in the right folder.** A link to a sent message opens in Sent and a received one in Received, every time, including while the panel is already open.
- **Received outside mail shows who got it.** The detail of a received org inbox message lists the agents it was delivered to, as links; a long list wraps instead of scrolling sideways.
- **Outside addresses are contact links everywhere.** Hub senders in mail headers, transcripts and history open the same contact menu, which now includes Open in org inbox.
- **Connections read as a list.** A hub's connections are rows with a presence dot, online first and then by most recent contact with the org, and long lists scroll and load as you go. Hovering an address says whether it is online and whether it is an org, a person or an independent chat. The local hub lists its connections too.
- **Request cards fold away.** Every question and request card has a fold button. Folded, it keeps one line with the asking agent, its linked docket items and the question's first line; drafts are kept, and the fold is remembered in every window.

## Panels and canvas

- **An X shows only where it closes something.** Panels end their pin and pop-out controls with an X when closing does something; the agent panel and the Needs attention panel no longer show an X when they are neither pinned nor popped out. While a dialog is saving or adding an account, its X stays visible but greyed out, like its Cancel button.
- **Panels that can be closed have a close button.** Centred panels and the temporary desk now end their pin and pop-out row with an X; Escape and clicking outside still close them.
- **Project badges open the right view.** A project's mail-queue badge opens its mailbox at the listeners folder, and its slot and listener badges open their own views. Hire strips on the switchboard and projects fold away when the pointer leaves, as agents' do.
- **The Claude Waves background no longer flickers while zooming.** It keeps a steady pattern as you zoom in and fades gently, rather than vanishing and popping back, when zoomed very far in.

## Consistency across Orgtree and with Hubchat

- **Every age uses one scale.** Lists, cards, the desk, the tray and the map all show ages the same way (3d, 3w, 5mo rather than 72h or 3600h), with the full date and time on hover.
- **Contact marks match Hubchat.** Offline is a hollow grey ring instead of red, a queued message shows Hubchat's clock, each delivery mark is named for screen readers, and with Hubchat connected a contact's icon is the same lettered avatar Hubchat draws.
- **Multi-replies read as in Hubchat.** Composers say "Replying to N messages", and long target lists fold to their first two with "and N more".
- **The mentions menu opens at the bottom.** The best match sits right above the message box, highlighted, and the menu stays scrolled there as you type. The highlighted name stays in view as you move with the arrow keys, which stop at the ends instead of wrapping around. It shows 20 names at first, as in Hubchat, and loads more as you scroll or arrow up, without the list jumping.
- **Menus and keys behave the same everywhere.** Urgent mail and questions in Attention have the Inbox's row menu; the context-menu key opens the selected row's menu in Mail, the docket and Presented; the first Escape clears a docket search before closing the panel; a ticket link's hover shows its status and name; watchdog links look and behave the same in tool calls and event cards; an idle agent with an error shows one error dot at every zoom level.
- **Lists load and retry the same way.** Transfer history loads more as you scroll, with Load more and Retry; app histories, Connections and the Apps menu retry a failed read; the gallery can search past presentations.

## Usage

- **Usage bars survive a failed refresh.** When a usage check fails (a rate limit, network error or timeout), the last good bars and their age stay on screen until the next successful check, instead of disappearing.

## Apps

- **App settings show a panel's log.** A new History tab lets you pick a panel and read its history in place.
- **App internet requests identify Orgtree.** Requests from apps carry a fixed Orgtree User-Agent, so services such as GitHub's API answer them; apps cannot replace it.
- **Moving or resizing an app panel can be cancelled.** Press Escape mid-drag, as with other pinned windows, and the panel stays where it was; nothing is saved.
- **Hubchat on this PC can open your local orgs.** Desktop Hubchat's "Orgtree org" badge becomes a link that opens an org this PC's Orgtree hosts, with no network and nothing secret involved.
