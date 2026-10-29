---
name: orgtree-ask-cards
description: Explain open and resolved ask cards, batch decisions, credit counteroffers and submission states.
---
Up: [orgtree-desk](../SKILL.md)

# Question and request cards

Ask cards are the user's actionable question/request surface. Open/pending cards accept an answer; resolved cards show the recorded outcome. They can appear in the inbox, attention view or relevant conversation without becoming separate independent questions.

## Question answers

A question's text and its option descriptions are formatted as chat is: Markdown, LaTeX math and clickable mention links to agents, docket items, presentations, apps and panels. Clicking a link in an option description opens what it names without picking the option. Option labels stay plain. The answered card shows the question the same way.

Options support single or multiple selection according to the card, with free text where offered. Selecting multiple options or typing is a draft, not immediate submission. The configured composer Enter behavior and Submit apply only when the answer is ready. Dismissing without an answer is a distinct response, communicated back to the agent.

## Folding a card

Question and request cards, open or resolved, fold from the chevron at the left of the header; a click elsewhere on the header row does the same. A folded card keeps one line: the asking agent, the linked docket item and the question's first line, or the names of its tabs. Its answer controls and its dismiss button are hidden, so folding never answers, skips or dismisses, and a draft survives it. The fold belongs to the request: every surface showing the card follows it, and it is remembered across reloads and restarts. An amended folded card stays folded and is marked changed until expanded. MCP permission and native question cards do not fold; they expire after five minutes.

## Mixed batches

A batch can contain question, credit and scope tabs. A tab is decided by an answer/approve/deny or explicit skip. Submission waits until every tab has a decision. A single-choice decisive click can advance to the next undecided tab; multi-picks and free text do not advance mid-thought.

Credit tabs let the user grant, deny or counteroffer within the shown capacity constraints. Scope tabs name the requested folder/tool/MCP/permission decision. They are not a blanket grant beyond what is actually approved.

## MCP permission requests

A correlated MCP request appears in the ordinary question-card frame as MCP permission with the server name. Form requests expose the supplied required fields, choices and numeric/text constraints; URL requests offer the supplied link to open yourself before accepting. Accept, Decline and Cancel resolve that request, which expires after five minutes. A failed submission leaves an error and can be retried while the request is valid. The decision is specific to this request, not a lasting scope or server grant, and the agent cannot answer it for the user.

## Outcomes and failure

Submission can optimistically hide the open card and queue its answer representation; a failure restores applicable drafts with its error. Changed question definitions invalidate incompatible old selections rather than pairing an old draft with new text. Do not infer server acceptance merely because the card disappeared locally.

Resolved cards distinguish answered, denied, dismissed, withdrawn, superseded, moot and interrupted records where present. A historical closed card is not an unanswered live request. A ticket's manual-attention flag is another mechanism; see [docket screens](../docket-screens/SKILL.md).

For agent-side question and credit-request parameters see `orgtree-tool-ask` and `orgtree-tool-request-credits` (orgtree-working › user). The card's UI does not authorize an agent to invent an answer.

## See also

- See `orgtree-tool-ask` (orgtree-working › user).
- See `orgtree-tool-request-credits` (orgtree-working › user).

## Restored native questions and plan approval

When an agent holds tools.orgtree_disabled, supported Claude Code/Codex/Muse native questions can use a private correlated card in the same question surfaces. Its heading names the harness, with Submit answer, Decline and Cancel. Choose options or answer in your own words; plan approval requires the explicit Approve choice and has no preselected approval.

Native request bounds are 65,536 encoded bytes, 1–4 questions and up to 16 options per question. Ordinary question text is at most 8,000 UTF-8 bytes, an option label at most 500 UTF-8 bytes, and an answer in your own words at most 500 characters. A supplied Claude plan is at most 32,000 UTF-8 bytes. The engine shares a 128-card capacity with MCP permission cards; Muse also allows at most 16 pending native question requests per host. Unsupported request shapes or limits return a refusal.

Cards expire after five minutes, disappear on process cancellation and accept one answer for that exact request only. A declined, cancelled, refused, expired or unsupported request returns a clear refusal to the harness. Scope/audience is checked before exposing the card and again before delivering an accepted answer. No native answer is written into ordinary answer mail or persistent permissions. Native questions without direct user reach instead become ordinary question mail to the superior, exactly as orgtree_ask routes them; their native call returns without approval and explains that the reply comes as mail. This opt-in grants no user audience or additional command/file rights.
