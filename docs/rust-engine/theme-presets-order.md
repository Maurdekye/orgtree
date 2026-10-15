# Theme preset labels and order

User 2026-10-14 23:01–23:02UTC renamed three presets to **LS Gold**,
**Muse Eggshell** and **Antigravity Navy**. Preset IDs, palettes and saved
settings values remain unchanged, including accents `#cda206`, `#afe5ff`
and `#75a5ff` respectively.

The menu order is Orgtree Grey, Claude Terracotta, Codex Teal, Antigravity Navy,
Muse Eggshell, OpenRouter Lavender, LS Gold, Custom. Shared
`PROVIDER_THEME_PRESETS` maps the existing provider IDs to preset IDs;
`VISUAL_THEMES` derives its order from that table for Display and onboarding.
Providers CLI sections sort a filtered copy using the same table; the existing
OpenRouter and Language server sections follow them. Orgtree stays first and
Custom last. Theme IDs remain appearance values, separate from provider IDs.

Round 445 (rig-sol-b, 2026-10-15) measured the original `a47bb16` targeted
suites passing 30/30 and composed source passing 31/31. The new mounted
provider/menu comparison passes with reversed discovery input. Existing label,
contrast, colour and persistence checks pass. Source audit at `7eb572a`
confirmed all seven palette expressions and preset keys, the accent registry,
saved-value validation and persistence/applyTheme logic unchanged; CSS only
renamed its preset comment. The later Rainbow gate is separately documented
in [Rainbow mode under Custom](rainbow-custom-toggle.md).

Saved logs `batch-445/logs/theme-labels-{base,tip}.log` and
`tc-root-final.log` record execution, zero skipped/cancelled targeted cases,
and zero root type errors. Strict renderer/tests retain their exact 29/830
baseline diagnostics, with zero added or removed after line/column
normalization. The batch-wide renderer result remains 3519 passes, 88
attributed baseline failures and four skips. These are synthetic DOM checks;
native installed-app and real preference writes were not exercised.

Coordinator integrated the checked implementation locally at `8d4c570`,
intended for `4.3.0-alpha.5`; no build or installed result is claimed.
