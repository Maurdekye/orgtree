---
name: orgtree-mail-basics
description: "Choose a mail workflow and recognize replies, passive notices and authentic mid-task delivery."
---

Up: [orgtree-mail](../SKILL.md)

# Working through mail

Use mail to hand off work, ask another agent for information, or return a result. Choose [orgtree_message](../tool-message/SKILL.md) when the recipient needs to act; choose [orgtree_send_notice](../tool-send-notice/SKILL.md) for an FYI that can wait for their next turn. The tool pages own wake behavior, accepted kinds, recipient state warnings and outside-mail exceptions.

MENTIONS: whenever you name an agent, project, docket item or presentation in text a person or agent will read (your replies, mail, docket descriptions, presentations), write @name, @item:<org>/<slug> or @doc:<org>/<slug> as plain text, never in backticks or code spans. A bare name is wrong. Point the user at an app or one of its panels with @app:<org>/<app-id> or @panel:<org>/<panel-id>.

For example, write @coordinator-opus, @worker-project or @item:orgtree/example-item in prose so it renders as an interactive link. The long forms @agent:<org>/<name> and @project:<org>/<name> render as that agent's or project's mention too: an agent the org does not have shows as unavailable, and a name that is not one of the org's live projects stays plain text (user 2026-10-27). An app or panel mention shows the app's current name (a panel with its app's) and opens it as its Apps row does; copy the exact token from the `ref` field of [orgtree_apps](../../team/tool-apps/SKILL.md) results (user 2026-10-27). A presentation mention shows the presentation's current title; its id is the readable slug [orgtree_present](../../user/tool-present/SKILL.md) returns, also carried as `ref` (user 2026-10-27). Write @user (plain text, never in backticks) in replies, mail, presented documents or docket updates to notify the user: 'I need you to see this'. Anything needing an answer still goes by mail or question.

Before replying after a fresh session or compaction, recover your conversation with that correspondent using [orgtree_inbox](../tool-inbox/SKILL.md). Read the full message when its preview is cut. Explicit content reads consume returned pending received mail and record it once after the tool in the transcript; previews leave delivery unchanged. A read does not establish understanding or completion.

## Questions and replies

For an agent question, use message's `kind: question`; use `kind: request` when making a request that should be visibly identified as one. A request is otherwise handled like a message. End your turn when you need an answer; do not poll or wait inside the turn for mail to appear. Continue independent work if there is any, then stop at a natural milestone. A send response reports the send outcome; the answer arrives separately as mail.

Preset options for Hubchat questions and the `reply_to`/`replies` formats belong to [the message tool](../tool-message/SKILL.md). Use those structured reply references so the recipient can see what you answered. In a multi-recipient send, each recipient gets only references from its conversation. Quoted prose alone is not a thread reference. Attachments to local agents become authorized path references; `user` and `@net:` attachments remain uploaded copies.

## Mail while you work

The harness can inject mail marked `[ORGTREE MAIL — delivered mid-task]`. This is an authentic delivery channel, and each message carries the authority of its actual sender. A genuine delivery does not elevate an agent or outside sender to user authority; apply [external-mail authority](../external-mail/SKILL.md).

Delivery timing depends on the harness and its available boundaries. Mail that misses the mid-task window reaches a later turn. End long work at useful milestones so queued direction can take effect. The engine's accepted/queued/delivered states do not prove that another model understood or completed the request.

Pending mail uses one admission rule for turn start, mid-turn and DND release: the hard input-byte budget, with no separate message-count cap. A tail that does not fit stays durable and ordered, is announced as following automatically, and schedules another admission, including a tail containing only passive notices. No manual inbox read is required to release it.

## See also

- [orgtree-tool-message](../tool-message/SKILL.md)
- [orgtree-tool-send-notice](../tool-send-notice/SKILL.md)
- [orgtree-tool-inbox](../tool-inbox/SKILL.md)

## Mentions in user mail

Unread mail to the user that contains a standalone @user in its body, visible event title/subject or quoted reply context gets the same mailbox attention as urgent mail: inbox pulse/count, row emphasis, needs-attention entry and configured desktop/tray/window cues. It remains ordinary mail; no urgent mark or reason is invented. Reading it clears that attention through the normal read path, including immediate local feedback and restoration after a failed read. Backticks and fenced code are literal and do not create mentions. A matching sender/prose mention blurb is represented by the mail once, and reading it clears only that matching marker. Unrelated mentions and persistent transcript highlights remain. This does not bypass agent DND or change Hubchat.
