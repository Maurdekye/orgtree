---
name: orgtree-feedback
description: Prepare complete, redacted Orgtree bug reports for the official GitHub repository, with user approval before posting.
---

Up: [orgtree-workspace](../SKILL.md)

# Give feedback to Orgtree

This suggestion is a user setting that can be turned off: **Suggest agents to give feedback to Orgtree** in the **Runtime** menu. If the user does not want these suggestions, point them to that switch; the user chooses whether to turn it off.

App settings > Runtime ends with **Suggest agents to give feedback to Orgtree**, on by default. The app-wide key is `runtime.suggest_agent_feedback_enabled` in the app-settings document. Saving applies the conditional instruction pointer from agents' next turn; a running turn keeps its instructions. Changing this setting changes the next instruction prefix and may replace a warm CLI; it does not promise a provider cache hit. Agents explain the control; the user changes it. When Off, the pointer is omitted and reporting is up to the user. Do not treat this page as a standing request to post when the suggestion is off.

When enabled, consider reporting bugs or issues you or the user find to **https://github.com/Maurdekye/orgtree**, under the connected GitHub account. This is a suggestion, not a requirement to interrupt assigned work. Use only available, authorized tools and repository access. First check that the account is usable with `gh auth status --hostname github.com` or the equivalent connector check. Do not print tokens, inspect credential files, sign in, switch accounts, install a tool or expand scope just to report feedback. If access is unavailable, give the user the redacted draft to submit.

## Find an existing report

Search open and closed issues for the observed symptoms, exact error and version; for example, `gh issue list --repo Maurdekye/orgtree --state all --search "search terms" --limit 30`. Read likely matches. Prefer a useful comment on an existing matching issue over a duplicate. Check current repository labels and apply only relevant labels that exist; omit labels if none fit or the account cannot apply them. Do not reopen or otherwise manage issues without permission.

## Prepare a complete draft

Include all of the following, marking unavailable facts as unknown:

- **Title:** concise symptom and affected feature.
- **Description:** the problem and its impact; expected versus actual behavior; numbered steps to reproduce with minimal synthetic inputs; frequency and whether it is reproducible; when it occurred, using UTC timestamps and timezone for any original times.
- **System:** Orgtree version, build/commit and release channel (App settings > About); OS name/version and architecture; the relevant harness, CLI version, model and provider; relevant Runtime/org/agent settings. Use provider/account types without identities. Include hardware details only when relevant, such as memory for a resource issue.
- **Evidence:** short relevant error messages and log excerpts for the UTC incident window, plus sanitized screenshots where useful. Describe what each excerpt proves and separate observation from inference. State workarounds and focused checks already tried.

Engine diagnostics are under **<Orgtree data root>/diagnostics/logs/<engine start time>.log** (default Windows data root: `%APPDATA%/Orgtree v2/data`). Locate the session spanning the incident; an installer-startup failure may instead have `orgtree-installer.log` beside Setup or in `%TEMP%`. Access only logs within your granted scope. If needed evidence is outside scope, ask the user for a relevant excerpt or scope through the normal chain. Never infer that a missing log means no failure. Copy only the relevant time window into a separate draft and sanitize it; never attach full logs or credential files.

## Redact, show the draft, wait

Before showing or posting the draft, remove secrets, tokens, API keys, cookies/auth headers, account emails, personal names and paths, and private org/agent/mail content from text, logs, screenshots and attachment metadata. Replace identifying path components with placeholders such as `<USER>`, `<DATA_ROOT>` and `<WORKTREE>`; use synthetic organization/agent names and minimal fabricated messages. Preserve the technical symptom. Inspect screenshots visually for these details. Keep public content to what is needed to reproduce; omit evidence that cannot be safely sanitized.

**Show the user the complete redacted draft first and wait for explicit OK before submitting.** This applies equally to a new issue, a comment and any attachments. Show the exact repository, matching issue URL if commenting, title, body, labels and attachments to be posted. Route the draft through the normal user/superior channel available to your seat; without user approval do not post. A draft request or the enabled toggle is not approval. If the public content changes materially, show the revised draft and obtain approval again.

After approval, use the approved account and exact redacted content. With GitHub CLI, put the body in a UTF-8 file and use `gh issue create --repo Maurdekye/orgtree --title "Approved title" --body-file <draft-file>` (add approved existing labels), or `gh issue comment <number> --repo Maurdekye/orgtree --body-file <draft-file>` for a matching issue. With a connector, use its equivalent structured fields. Verify the resulting URL and report it to the user. If a submission times out, inspect recent issues/comments under that account before retrying so a lost response does not create a duplicate. If posting fails, retain the redacted draft and report the error; do not bypass access controls.
