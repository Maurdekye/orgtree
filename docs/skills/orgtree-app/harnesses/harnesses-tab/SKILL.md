---
name: orgtree-harnesses-tab
description: Explain the installed-harness registry, versions, compatibility tags and missing-install guidance.
---
Up: [orgtree-harnesses](../SKILL.md)

# Harnesses tab

App settings → Harnesses is a compact inventory, not a provider-login page. It reads the same engine registry that validates harness choices.

Rows show harness name, installed/missing state and discovered version; an installed entry with no usable version says “version unknown.” Missing entries get an install link when supplied. OpenRouter/Language Server tags indicate compatibility and are independent of installation. Listing the page reuses cached discovery versions rather than launching CLIs to obtain them.

Only compatible installed harnesses can be selected. A saved missing choice is retained as an unavailable value, so launch can explain the error rather than silently changing harness. OpenCode installation additionally needs the negotiated ACP entrypoint.

No per-row setting is saved by reading this page. Installing/signing in requires the user's action; opening an install link does not prove success or model entitlement. A provider's Refresh/status can update discovery after installation.

Read the harness leaf for runtime/permission caveats, which the compact row intentionally does not display:

- [Claude Code](../harness-claude-code/SKILL.md)
- [Codex](../harness-codex/SKILL.md)
- [OpenCode](../harness-opencode/SKILL.md)
- [Antigravity](../harness-antigravity/SKILL.md)
- [Muse Code](../harness-muse/SKILL.md)

For model/key/server routing use the specific provider settings rather than inferring billing from this inventory.

## See also

- [orgtree-harness-claude-code](../harness-claude-code/SKILL.md)
- [orgtree-harness-codex](../harness-codex/SKILL.md)
