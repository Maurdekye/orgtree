# Project watchdog navigation and outlines

User 2026-10-19 19:06–19:07Z, Orgtree 4.4.0: slot-holder and waiting chips
offer **Project…**, using the same project-link action and shared registry as
project links elsewhere. Click/Enter on the parent focuses the project;
hover/Right opens its menu, including Copy mention, Focus and supported Open
routes. The chip's normal click still opens the project's Slots surface.

The shared watchdog object menu adds the same parent whenever its target,
after removing an optional leading `@`, resolves to a project in the current
tree. This applies to every watchdog kind, without guessing from commands or
target substrings. It reads the current canonical menu at menu-open time.
Unknown targets, foreign org objects and spent dogs keep existing gates.

Canvas satellites, desk jump cards, detail headings, transcript references,
mobile dog lists, project listener rows and slot waiting rows use that same
menu. Nested agent links in project rows retain their own canonical menus.
Pause/Resume/Remove and left-click detail routes are unchanged.
Slot waiting rows render a real `tr` through the shared row wrapper; their
seven cells, Position column and coloured SlotTime values remain intact.

Event listener/watch dogs use cyan, fair-queue mail listeners magenta, and
slot claims yellow. One-shot perimeters are dashed, preserving kind color;
ordinary one-shot dogs use the normal grey perimeter without a yellow glow.
The same kind treatment reaches desk jump cards and mobile list borders.

User 19:35:54Z: listener-count watches have a double cyan outline. Continuous
watches use a 3px double border. One-shot watches use a dashed 1px outer border
and a solid inner cyan ring, preserving both the watch and one-shot signals.
The mobile list uses the same double/dashed pair on its left-hand kind edge.

Focused tests: `project-dog-menu.test.tsx`; real-component native specimens:
`project-dog-visual.tsx` and `project-dog-capture.cjs`. All data are synthetic.

User 21:10Z: watchdog identity links use one shared `WatchdogLink`, including
tool references, event/transcript/mail cards, mail-listener rows, slot waiting
reasons, mobile lists and detail headings. Event listener tables also consume
this component. It reuses the cards' kind outline classes, lifetime flags and
glyph helper. Its default route resolves metadata from the current org's tree;
foreign-org or unknown IDs do not acquire another org's appearance or action.
Unknown metadata uses a neutral chip, and a recorded removed identity retains
its copy-only stale menu. The detail heading keeps its menu without reopening
its own panel. Mode is available in the tooltip, without a separate continuous
label in the listener table. `watchdog-links.test.tsx` and the synthetic
`watchdog-link-{visual.tsx,capture.cjs}` cover the shared link behavior.

Follow-up 21:18Z: canvas and desk link perimeters use one late CSS kind-color
rule, including hovered one-shot links; mode words are omitted from mail
listener cells as well as event listener tables. The chip tooltip retains mode.
