# Compact choice (4.4.0)

User 2026-10-17 17:15Z requested plain Halt when it acts immediately and a
Compact… menu entry that opens a normal/cheap choice. Coordinator 17:18Z
confirmed cheap-only bulk scopes, actual harness capability and truthful refusal
messages; this adds no harness compaction support.

The shared agent menu shows Halt or Unhalt without dots for a direct action.
When an actual team submenu exists, it keeps the ellipsis. Compact… opens the
same choice modal as the desk context wheel. Each option has one explanation:
normal uses the harness's existing conversation compaction; cheap starts a fresh
session with a summary handoff on the same agent, keeping settings and team.
Cancel takes initial focus, Tab stays inside and Escape restores the opener.
The modal also retains the next-turn cache forecast warning when backend
state is known_incompatible or expired_known_entry, including its supplied
reason. Ready, uncertain or absent evidence never becomes cold merely because
the last turn is old; the warning makes no fork or pricing claims.

The modal reads GET /api/orgs/{slug}/nodes/{nid}/compact. This read resolves the
same effective OpenRouter stamp/account setting or language-server route as the
actor, without starting a process. Native Claude, Muse and explicit Claude Code
routes support the existing normal action; Codex, Antigravity, OpenCode and
unknown routes show the normal option disabled with a reason. Read failure or
pending capability disables normal only. Live/busy/session/bearer gates remain;
POST still rechecks admission and its started:false response is a refusal, never
a started-compaction toast. Cheap uses the existing cheap_compact operation.

Managers keep Cheap compact subtree… and Cheap compact all subordinates….
These use existing bulk confirmation, eligibility, if_idle and partial outcomes;
normal compaction is never fanned out. The org-root bulk action is unchanged.

## Focused evidence

Engine red at 5894d94: four cases, two intended failures (OpenCode/unknown
routes falsely supported) and two passing controls. Corrected renderer red at
2d8cdd7: nine cases, six intended failures and three controls, raw exit1; the
first modal fixture's invalid portal queries are retained separately. Author
green results and exact SHA are recorded in the docket/hand-in after execution.
