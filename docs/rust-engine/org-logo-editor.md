# Organization Logo editor

User 2026-10-13 requested the verified Hubchat Account-avatar interaction in
organization settings, with the name **Logo** and a hint that it appears as the
org's account picture in Hubchat. The round avatar opens the existing file
chooser directly; its always-visible pencil is bottom-right. A separate
focusable X at top-right removes an existing logo, without activating the
chooser. No X is shown for an empty logo. Buttons have labels, tooltips, native
Enter/Space activation and theme-driven hover/focus/disabled styles.

The existing org owner load/refresh, revision/intent guard, decoder preview,
5 MiB/16 megapixel PNG/JPEG/WebP limits, crop sliders, save/remove requests and
storage remain unchanged. The file input is hidden; crop controls appear after
selection. Only visible terminology changes, including native error wording
from picture to logo. The hint's account-picture wording is intentional.

Fallback copies Hubchat `Avatar` org-kind rules: its exact initials algorithm
(`lib/format.ts`, first and last word initials, punctuation stripped, uppercase,
or `?`), Segoe UI Variable Text/Segoe UI/system font, weight600, .01em spacing,
and 72px/26px (desktop), 96px/34px (mobile) size ratios. Hubchat's org colors are
dark ink `#e3896b` over `rgba(217,119,87,.20)` and light ink `#b04f2c` over
`rgba(217,119,87,.18)`. These are independent of Orgtree provider-theme accents;
light and solarized-light use the light values. The explicitly requested round
shape is local to the Logo editor; Hubchat's org avatars elsewhere keep their
existing rounded-square shape. Pencil/X geometry mirrors the verified Account
editor (25px bottom and23px top badges, 15px icons), with Orgtree MUI icons and
theme variables for control chrome. App passes the real org name, not its slug,
for the fallback initials.

Focused owner/crop tests retain all five previous cases, with selectors updated
for the requested visible labels. New cases cover fallback names, hidden chooser
activation, X isolation/conditional state and error terminology/retry.
`tools/org-logo-verify.mjs` prepares matched base/tip tests and actual browser
proof of eight accent themes (seven presets plus custom) across all four contrast
modes, plus image/crop/keyboard/removal/limits/errors. Synthetic fetch and chooser
seams prevent real settings or account writes. Output stays in the owned C build
scope under a shared-lock/kernel-Job renderer phase; no engine/app build.

Verification is pending. Native image decoding, real hub publication, installed
artifact and interactive native chooser acceptance are outside this proof.
