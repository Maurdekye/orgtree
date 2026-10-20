# Docket and transcript ticket menus

USER 2026-10-20 17:26:35Z requires the exact same item menu for docket rows
and ticket links everywhere, including quick Staff on backlogged items. This
supersedes the earlier separate transcript menu with row-only Staff. Coordinator
clarification 17:27:20Z keeps Show/Hide sub-items only where a real list fold exists.

## Exact menu

Both call `ticketMenuEntries` in `canvas/ticketmenu.ts`; there is no separate
reduced link menu. It uses `ticketReferenceActions` and `ticketOwnerAction` for:

1. Open details (always that label; an already selected docket row stays open).
2. Owner... (displayed with an ellipsis glyph), when the ticket has an owner.
   Its submenu starts with Copy mention, then the current canonical agent
   entries. Selecting its parent invokes the enabled Focus entry. With no
   available Focus, the parent is action-disabled while the submenu stays usable.
3. Separator.
4. Copy ticket title (full title).
5. Copy slug.
6. Copy reference (@item:org/slug).

Both add Staff when the ticket is unarchived, backlogged and scoped to a real
org, using the same `ticketStaffEntry` and existing `quickStaffEntry`. Rows alone
may insert Show/Hide N sub-items before Staff when kids>0, a real fold callback
exists and search has not locked folding. One separator precedes these actions,
and none appears when neither exists. Canonical node Open submenus remain second
at every level through the shared context-menu renderer.

Rows retain draw-time warm-up, pointer/focus refresh and loading/error updates.
Reference menus fetch the current item, reuse any held staffing preview, and
otherwise join the existing single-flight per-ticket preview request. The engine
preview reads cached availability; links do not mount a hidden docket, poll or
invent provider/model choices. Preview refusals produce the same disabled Staff
entry as rows. Existing request/direct modes, model/effort/account gates,
idempotent submission and commit-time revalidation remain in `quickstaff.ts` and
the engine's quick-staff endpoint.

Left clicks still toggle docket selection, and double-click still copies the
slug with its existing success bubble and selection cleanup. The context-menu
Open details route uses the latest selection so it never closes an open ticket.
Copy slug keeps its existing row feedback; title copy uses the canonical value
and feedback. Normal product row callers supply org. The unscoped standalone
row retains its existing omission of Copy reference/Staff instead of inventing
an org. Manual attention flags do not add a dismissal menu; detail-pane dismissal
controls are unchanged. The stale row comment claiming such an entry is removed.

ObjectNavHost routes its current item to the same builder as DocketRow; its
owner entry retains the canonical labels, child order, Focus gate and callback.
The common menu wrapper leaves explicitly supplied Copy ticket title in its
canonical position, without prepending its automatic copy entry/separator.
Other automatic object-copy paths and more-specific agent/object menu precedence
remain unchanged. Reference menus now include the complete item actions,
including Staff; list-local folds remain on their actual rows.

## Focused verification

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
