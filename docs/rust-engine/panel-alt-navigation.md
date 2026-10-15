# Alt arrows in presentations and work panels

Alt+Up and Alt+Down select the previous or next presentation or ticket in the
focused panel, mirroring mail's panel-level bubbling handler. All four shared
organization/agent panels use `usePanelSteps`; their desk, modal and detached
hosts therefore use the same selection and viewer paths.

The root has `tabIndex=-1`. The caller supplies its existing rendered order:
the gallery's hired/retired partition, or docket sections after filtering,
sorting, nesting and folding. Collapsed categories and children are skipped.
The selected parent remains one stop when its children are folded. The keys
clamp at both ends; with no eligible selection either key opens the first row.
Docket order includes eligible rows outside the bounded DOM viewport, and its
existing window hook mounts the new selection before nearest scrolling.
The keyboard path does not toggle an already selected row closed.

Already-consumed chords, inputs, textareas, selects, contenteditable elements,
question cards and controls owning arrows keep the event. Lookups use the
root's owner document, including a detached window. A blurred unsent reply,
staged/uploading attachment, pending reply send or staged question/credit answer
also blocks switching, because unmounting its pane could discard local state.
The reply and ask components expose only a boolean `data-panel-draft` marker;
their existing shortcuts, submission and persistence behavior are unchanged.
Clearing a reply draft releases panel navigation. Mail's navigation handler is
unchanged. App settings' shortcut list documents the new binding.

## Evidence and limits

Base is `72ea305a4718655c7c0ea123edfe187e97afe393`. The tests-only checkpoint
`3eb45d5` executed 30 cases: eight preservation controls passed, 20 genuine
navigation assertions failed, and two category-fold fixtures failed their
pre-key calibration. The latter selected the first status section although
Open follows Blocked and In progress. Tests-only `48d400b` targets the selected
alpha row's own category and retains hidden-row and remaining-row assertions.

The current mounted suite prepares 36 cases, adding draft-release checks on
all four surfaces and real question-option/inactive-batch-tab draft checks.
Corrected red, green, adjacent suites and typechecks are pending rig-sol-b;
no green execution is claimed by this source hand-in. The portable runner
injects all four changed existing panel/composer files from the exact base for
red, using current tests and existing dependencies read in place. Generated
bundles stay under the rig's assigned C build directory.

These are synthetic jsdom checks: the detached case uses a separate iframe
document, and `scrollIntoView` is observed as a nearest-scroll request.
Native keyboard delivery, OS focus/placement, installed behavior and pixels
are not measured. The author runs no app, provider or live-data changes.
