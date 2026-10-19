# Quick chat width stability

The centered header and footer share `shell/equalsides.ts`. Each side gives up
free space before Quick chat shrinks from its preferred width; its minimum
remains 200 CSS pixels. This preserves the user's 2026-10-10 layout rule.

The side's measured controls must not depend on its previous flex allocation.
During the synchronous measurement, temporarily use `min-width: max-content`,
read the controls, gaps and padding, then restore the original inline value and
priority before paint. Publish a custom property only when its value changes.
Observe nested content changes as well as control resizing so translated text,
changed titles and late org logos refresh the measurement.

`quickwidth-layout.tsx` mounts actual shared headers and a footer in a synthetic
document. The Electron regression samples 80 successive frames per configuration
after warmup, at widths including 1280, 1024, 800, 640 and 512 CSS pixels, then
changes title/control text and widens again. It asserts settled geometry, the
200px floor and width recovery. Its capture waits two animation frames and a
paint delay. The fixture uses fake native controls and no engine or user data.
