# Quick chat file picker

The compact hire-options dropdown stays open when its empty Files paperclip
opens the existing native file input. Selecting files updates its attachment
count; cancelling returns to the same dropdown. The existing attachment list
opens beside it and its Add files action keeps both popovers mounted. Native
dialog blur does not dismiss these popovers. Escape and outside pointer presses
retain their usual dismissal behavior; attached files stay in the composer.

The wide Quick chat row, upload/send path and file capabilities are unchanged.
This corrects the premature explicit `back()` call on the empty-files action
(user report 2026-10-19, 4.4.0-alpha.12).

Focused mounted coverage: `apps/desktop/renderer/tests/quickchat-narrow.test.tsx`
sections 7.1–7.3 exercise picker launch, blur/cancel, selection/counts, Add files,
outside dismissal and the wide-row control using synthetic files. The fixture
does not open a real OS dialog, upload files or hire/send to an agent.
