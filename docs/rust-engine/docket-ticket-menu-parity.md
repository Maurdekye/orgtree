# Docket and transcript ticket menus

User 2026-10-14 23:04Z requested the same context menu for docket rows and
transcript ticket cards. After a read-only comparison, the user ruled
"Match + keep extras" at23:06:53Z. This source-only change starts on rust-engine
a47bb16; the coordinator integrates and rig-sol verifies.

## Exact menu

Both use ticketReferenceActions with ticketOwnerAction for the same owner route:

1. Open details (always that label; an already selected docket row stays open).
2. Owner... (displayed with an ellipsis glyph), when the ticket has an owner.
   Its submenu starts with Copy agent name, then the current canonical agent
   entries. Selecting its parent invokes the enabled Focus entry. With no
   available Focus, the parent is action-disabled while the submenu stays usable.
3. Separator.
4. Copy ticket title (full title).
5. Copy slug.
6. Copy reference (@item:org/slug).

Docket rows then add one separator, followed by Show/Hide N sub-item(s) when
kids>0, a fold callback exists and search has not locked folding; and Staff...
when the ticket is unarchived, backlogged, and scoped to a real org. No extra
separator appears when neither extra exists. The existing draw-time staffing
queue, pointer/focus refresh, held preview, loading placeholder and async entry
replacement are unchanged. Staffing/model/action behavior is unchanged.

Left clicks still toggle docket selection, and double-click still copies the
slug with its existing success bubble and selection cleanup. The context-menu
Open details route uses the latest selection so it never closes an open ticket.
Copy slug keeps its existing row feedback; title copy uses the canonical value
and feedback. Normal product row callers supply org. The unscoped standalone
row retains its existing omission of Copy reference/Staff instead of inventing
an org. Manual attention flags do not add a dismissal menu; detail-pane dismissal
controls are unchanged. The stale row comment claiming such an entry is removed.

ObjectNavHost's owner entry is extracted without changing its labels, child order,
disabled condition, Focus callback, clipboard behavior or async lookup contract.
The common menu wrapper leaves explicitly supplied Copy ticket title in its
canonical position, without prepending its automatic copy entry/separator.
Other automatic object-copy paths and more-specific agent/object menu precedence
remain unchanged. Transcript menus have no extras, so their visible behavior is
unchanged.

## Verification hand-in

Source/whitespace inspection is complete; runtime verification is pending rig-sol.
No renderer jobs, app builds, installs, live-data operations or pushes were run.

New docketmenuparity.test.tsx has22 tests. Sixteen compare real DocketRow menus
against a real transcript WorkRefText/ObjectNavHost menu for open/backlogged,
archived/unarchived, flagged/unflagged and owner/no-owner combinations. Comparison
includes labels, order, separators and owner submenu contents, followed only by
expected extras. Each proves no duplicate title, old Close details, flat owner or
Dismiss entry; no right-click staffing mutation; and warm-up before interaction.
Six action/edge tests cover idempotent Open details with unchanged primary click,
copy values/success bubble and fold toggles, canonical owner Focus/children,
missing Focus with accessible copy-only submenu, search-locked/ineligible extras,
and unscoped rows. New absence checks compare booleans, never serialize DOM nodes.
The existing contextmenu sectionB4 is aligned with the new approved order/owner
registry and checks copied reference bytes instead of an obsolete tooltip.

Focused batch files:

    docketmenuparity.test.tsx
    objectnav.test.tsx
    contextmenu.test.tsx
    copytitles.test.tsx
    staffingmenu.test.tsx

Run root typecheck and these renderer filters in rig-sol's existing contained
shared-lock phase using its normal C output/dependency setup. For a red control,
run only the new docketmenuparity test file against a47bb16 product sources, with
that test added; it imports no new production symbol. Expect menu parity, selected
Open details, Owner and locked-fold assertions to fail. The exact red count is
unmeasured; copy/fold and unscoped cases are controls that may already pass.
No historical file replacement is needed in the combined verification branch.

Read existing real dependencies in place; do not install, copy or junction
node_modules into this source worktree. No installed-app or rendered-pixel claim.
