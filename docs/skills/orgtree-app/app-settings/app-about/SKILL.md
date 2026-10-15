---
name: orgtree-app-about
description: Explain displayed desktop and engine versions, update checks and the source link.
---

Up: [orgtree-app-settings](../SKILL.md)

# About

About is a read-only reference plus the manual update-check action. It covers `screen:about`; it has no user-editable version setting or default version number. Agents explain what it reports and may suggest a check; they do not operate settings themselves.

The **Orgtree** row is the packaged desktop version when the shell provides one. The **engine** row uses the backend's branch and commit, with its start time in the hint. A plain browser is not assigned an invented desktop version. Unknown engine data is omitted, and a version unknown row appears when neither desktop nor engine identity is available. The **source** row opens the project's GitHub page.

**Check for updates** appears only when the desktop bridge supports it. Its pending button says Checking and is disabled until the call finishes. Results distinguish up to date (with the running desktop version when known), downloading with optional percentage, ready to install, and unavailable/failed requests with the actual error. Ready to install points to Update now in the header; a successful check does not itself prove installation or restart.

Suggest checking the About rows when establishing which code is running or comparing desktop/engine identity. A commit being present in a running build is separate from demonstrating that a feature works. Suggest Check for updates when the user wants availability information; automatic update policy is a different control.

## See also

- [orgtree-app-runtime-desktop](../app-runtime-desktop/SKILL.md).
