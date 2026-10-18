# Reply quote navigation

User ruling, 2026-10-18 11:21–11:22 UTC: presentation replies show the presentation
title, with ellipsis and a full-title tooltip. A missing or unreadable target has
a clear fallback; its raw id is never a presentation label.

The shared reply frame activates from its whole block, Enter or Space, with a
hover highlight, focus ring and action tooltip. Nested links, remove buttons and
text selection retain their own behavior. Mail and docket targets retain their
canonical reference routing. Multi-reply quotes reuse the same components.

Presentation titles come from the current scoped index when supplied, otherwise
an exact `getDocument(org,id)` read. Concurrent reads coalesce only while in
flight; this does not fetch a growing gallery prefix or mark a document viewed.
An identity guard discards stale answers. Foreign, removed and unreadable
presentations keep the quoted context and an unavailable label.

A deliberate jump to an older transcript source loads one existing history page
at a time until that exact source is found, history ends or loading fails. A
conversation identity change cancels the request. Clear history anchoring before
centering the result, using `centerTranscriptTarget` on its owning list. Mailbox
exact-id lookup similarly centers only its own list; desk frames never scroll.

Focused coverage: `replytarget.test.tsx`, `replyhistoryjump.test.tsx`. The single
synthetic capture fixture is `reply-quote-layout.tsx` and checks long titles,
tooltips, multi-replies, unavailable targets, nested links and keyboard focus.
