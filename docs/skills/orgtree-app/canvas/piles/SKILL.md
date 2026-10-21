---
name: orgtree-piles
description: Distinguish active crowd stacks from retired piles and choose which agent is visible at the front.
---
Up: [orgtree-canvas](../SKILL.md)

# Stacked agents

A pile is a display grouping, not a new manager or a merged conversation. Its front is the agent you can focus/message; hidden members keep their own identity and work. Open the stack picker to bring another member forward.

Two independent grouping rules apply:

- Retired siblings form a retired pile when at least two are represented, including unloaded retired-count metadata. The picker loads 50 rows on opening and more as you scroll (or choose Load more). Search by name finds case-insensitive substring matches across the whole pile, including rows not yet loaded. With hide-retired active, individually revealed retirees remain separate cards rather than being buried again in a pile.
- When crowd piling is enabled and a parent has more than eight non-archived, non-draft reports, at least two leaf reports can share a Team stack. Non-leaf reports keep their own columns and the draft is never stacked. This does not stop the buried workers.

The picker lists most recently touched agents first using their last activity/turn information, with tier/name, busy/mail indicators, last-turn age when known and an in-front mark. Choosing a row changes which card fronts the stack; list sorting and canonical sibling order are separate things. A displayed total can exceed currently loaded rows while archived data is arriving.

The retired-pile picker also offers Delete all when the human action is available, behind a permanent-deletion confirmation. It covers the entire pile, even while a name search is active: only after confirmation does it visit each page and process individual deletes, reporting how many succeeded. Do not promise atomic deletion of the whole pile or rehire afterward. Transcript files can remain on disk even after identity deletion. Deleting is different from merely changing a front or dismissing a revealed retiree.

Dragging a retired stack's front can reorder its members as a block; ordinary [canvas](../org-canvas/SKILL.md) drag and engine validation still apply. For the crowd/hide-retired display choices and their defaults, see [Display: desk and chart](../../app-settings/app-display-desk-and-chart/SKILL.md). For capacity effects of retirement, see `orgtree-tool-retire` (orgtree-working › team); stacking alone frees no seat.

## Project bunches

Agent and project retired-list badges use their header flow. The org's root
retired-list badge sits below the YOU card, above resting cards but below its
active hire controls; the badge cannot cover or intercept those hire buttons.

Project bunching is separate from crowd stacks and retired piles. With Bunch consecutive projects enabled (the default), an uninterrupted chain of projects is packed in a compact, ordered, round serpentine group. Hidden retired branches do not break a live chain; archived columns can bunch too. Each project remains its own node, desk and menu. The optional rearrange-on-drag setting is off by default: turn it on to rotate the bunch around the grabbed project while dragging; ordinary structural drop validation still applies. These choices live in [Display: desk and chart](../../app-settings/app-display-desk-and-chart/SKILL.md).

Retired project fronts retain their folder identity and can open the same retired-pile picker as agent fronts. Opening the owner's desk hides the card's inset retired token; the desk keeps its own retired-list access.

## See also

- [orgtree-app-display-desk-and-chart](../../app-settings/app-display-desk-and-chart/SKILL.md)
