# Docket opening selection

An org Docket with no requested or restored selection selects its first visible
unarchived, non-backlogged ticket after the initial list finishes loading. It
uses the displayed grouping, nesting, sort and folds. A requested ticket wins.
The existing org-scoped navigation sequence consumes the opening default; a user
selection or deliberate clear prevents later polls from selecting another item.
An empty opening also consumes the default. Changing org resets the boundary.

The popped-out org Docket uses the same DocketModal. Agent/team lists use their
existing separate path and are unchanged. No header layout changes are included.

Measured at bceb960 on base9a40732: eight new cases passed plus four native paging
regressions (12/12, no skips). The exact base docket module overlaid in the same
fixture had five expected failures and three preservation passes. Typecheck
passed at the identical production source6f52977. Synthetic native-renderer
screenshots in light/dark show the nested parent selected with detail displayed;
clear then live update and explicit jump both retain the intended state.

Limits: the comparison overlays the exact changed git object rather than running
a second full checkout. Pop-out parity is established by the shared source path;
no separate native pop-out session, installed app or live organization was tested.
