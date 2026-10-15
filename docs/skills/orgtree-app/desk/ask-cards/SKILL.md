---
name: orgtree-ask-cards
description: Explain open and resolved ask cards, batch decisions, credit counteroffers and submission states.
---
Up: [orgtree-desk](../SKILL.md)

# Question and request cards

Ask cards are the user's actionable question/request surface. Open/pending cards accept an answer; resolved cards show the recorded outcome. They can appear in the inbox, attention view or relevant conversation without becoming separate independent questions.

## Question answers

Options support single or multiple selection according to the card, with free text where offered. Selecting multiple options or typing is a draft, not immediate submission. The configured composer Enter behavior and Submit apply only when the answer is ready. Dismissing without an answer is a distinct response, communicated back to the agent.

## Mixed batches

A batch can contain question, credit and scope tabs. A tab is decided by an answer/approve/deny or explicit skip. Submission waits until every tab has a decision. A single-choice decisive click can advance to the next undecided tab; multi-picks and free text do not advance mid-thought.

Credit tabs let the user grant, deny or counteroffer within the shown capacity constraints. Scope tabs name the requested folder/tool/MCP/permission decision. They are not a blanket grant beyond what is actually approved.

## Outcomes and failure

Submission can optimistically hide the open card and queue its answer representation; a failure restores applicable drafts with its error. Changed question definitions invalidate incompatible old selections rather than pairing an old draft with new text. Do not infer server acceptance merely because the card disappeared locally.

Resolved cards distinguish answered, denied, dismissed, withdrawn, superseded, moot and interrupted records where present. A historical closed card is not an unanswered live request. A ticket's manual-attention flag is another mechanism; see [docket screens](../docket-screens/SKILL.md).

For agent-side question and credit-request parameters see `orgtree-tool-ask` and `orgtree-tool-request-credits` (orgtree-working › user). The card's UI does not authorize an agent to invent an answer.

## See also

- See `orgtree-tool-ask` (orgtree-working > user).
- See `orgtree-tool-request-credits` (orgtree-working > user).
