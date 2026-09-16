# Orgtree 2.1.6-beta.4

This beta is about the interface getting out of your way and the docket not
painting itself into a corner. An answered question no longer parks a
full-size card in your chat after a restart, a work item's description can no
longer become permanently unwritable, and the zoomed-in agent desk gets its
document panel proportioned correctly along with pin, pop-out and open-as-modal
buttons on all three of its tabs.

It carries everything from the earlier 2.1.6 betas: the streamed-output memory
and latency fixes, renderer crash recovery, the crash when expanding a question
answer, the installer refusing an upgrade over unrelated programs, and agents
whose conversation file had moved.

## Upgrading an existing installation

This is a prerelease. A stable 2.1.5 installation ignores prereleases, so the
tray's **Update now** will not offer it — install this build by hand once. From
then on the installation sits on the `beta` line and receives later betas and
the eventual stable release automatically.

## An answered question no longer comes back after a restart

An answered question could reappear in the chat pane as a full-size card after
a restart — the whole question body, the code block, the `answered` chip and
the answer as its last line — taking roughly a screenful of scrollback and
sitting between you and your conversation until it eventually cleared on its
own.

It cleared after fifteen minutes. That was the whole of it: a timer, not an
event, which is why there was never anything you could point at as the thing
that finally dismissed it.

The desk deliberately holds a just-answered question on screen for a short
while, so the answer has one visible representation until the answer itself
appears in the transcript. That hold was measured purely in wall-clock time, so
it outlived the process that started it. A restart reloads the page, the fresh
page has no record that the answer was already shown, and it cannot re-derive
one from a transcript that no longer contains the pre-restart answer — so the
card re-pinned itself and stayed.

The hold is now bounded by the current session as well as by the clock: a
question answered before this session began is not one this session needs to
hand over. The card is collapsed, not erased — the answered question keeps its
place in your inbox exactly as before, and an answer genuinely still in flight
at restart falls back to its own bubble rather than vanishing.

## A work item's description can no longer freeze

Once a work item had accumulated a hundred revisions of its description, that
description could never be changed again — and no decision could be recorded on
it either. All three routes passed through the same limit and all three were
refused.

The refusal named a remedy: consolidate the settled rulings into the
description. That remedy was itself one of the refused operations. An agent
following the instruction it had just been given received the same error a
second time, and there was no way out from inside the tool.

Past the limit, the oldest revisions now roll over into an archive that has no
limit of its own. This is not truncation and not summarising — a rolled-over
revision keeps its number, its timestamp, its author, its complete before-and-
after text and its links to the revisions it replaced. Nothing is discarded, so
the guarantee the history exists for is intact, and raising the number would
only have moved the day the problem arrived.

The second half matters more day to day. An item whose description has stopped
being the complete story now **says so where the description is read**, not
only when a write fails. The notice appears above the description in the docket
pane, travels with the item when it is handed to another agent, and
distinguishes two genuinely different situations: a description that is simply
partial because part of its history has moved to the archive, and one that is
incomplete because rulings made while the item was frozen were never recorded
at all and cannot be recovered.

## The agent desk's document panel is the right way round

The zoomed-in agent desk's presented-documents tab split its panel backwards:
the list of document titles took just over half the width, and the document
itself was left the narrower half. That proportion had been borrowed from the
docket tab beside it, where it is correct for a different reason — a docket row
is a name you read in the list, whereas a presentation row is a title you click
to open something, and the something is the half that has to be readable.

The tab now uses the same rule its own popped-out and pinned panel already
used, rather than carrying a second copy of the number. The document gets
roughly two thirds. The docket and inbox tabs were measured and left alone;
neither had the problem.

## Pin, pop out and open as a modal, from the desk itself

The presented-documents, docket and inbox tabs of the agent desk each gain
three buttons in their corner:

- **Pin** pins that tab's panel, exactly as the pin in a panel's title bar does.
- **Pop out** opens that tab's panel as its own window.
- **Open as a modal** opens that tab full-size, the same view you get from the
  agent's right-click menu.

Each button acts on that tab's own view — the docket button pins the docket,
the inbox button pins the inbox — and each one runs the same code the existing
route already ran rather than a second implementation of it. The buttons appear
only on the desk's tabs, never inside the modal they open, which already has a
pin and a pop-out in its title bar.
