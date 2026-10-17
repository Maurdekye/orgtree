---
name: orgtree-dev-team
description: Use the bundled development-team shape with a coordinator, accountable implementer, redteam reviewer and curator.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# The dev-team system

Use this pattern to build and maintain a deliverable with clear responsibility for orchestration, implementation, review and documentation. It describes the four bundled `devteam` templates and their charter presets. Selecting a template creates a starting layout; it does not automatically run a review process or authorize a build, deployment or live-data change.

## Roles and reporting shape

Each bundled template places one coordinator directly under the user and three direct reports beneath it. The implementer, redteam and curator are siblings; the redteam and curator are not a management layer between the implementer and coordinator.

| Role | Responsibility from its charter |
| --- | --- |
| Coordinator | Clarify and record the user's request, assign one accountable agent per piece, coordinate dependencies and follow work through to completion. Answer simple questions directly; delegate substantive investigation, execution and review. Read a report's actual files and transcript before asking it to repeat its status. |
| Implementer | Own the deliverable end to end: design, assemble adopted contributions, build, verify and deliver within the assigned authority. Verify peer input before adopting it; authors retain credit, while the implementer takes responsibility for adopted work. |
| Redteam | Reproduce and diagnose defects, attack the intended fix and provide measured findings or measured-clean results. Its charter restricts writes to tests; the implementer owns product fixes. |
| Curator | Read current sources, answer with re-checkable evidence, and maintain documentation and durable records. Its charter restricts changes to documents and records. |

Keep the team flat by default. The coordinator charter permits an intermediate manager when coordinating the direct reports would otherwise consume too much bandwidth; it does not require a new manager for every feature. Check for an existing owner before staffing, and give each worker the folders and tools its actual task needs. Charters describe responsibilities; they do not replace tool permissions, folder scope or user authorization.

The four shipped template definitions use these tier IDs:

| Template | Coordinator | Implementer | Redteam | Curator |
| --- | --- | --- | --- | --- |
| `devteam-claude` | `opus` | `opus` | `opus` | `sonnet` |
| `devteam-codex` | `sol` | `astra` | `sol` | `luna` |
| `devteam-antigravity` | `argon` | `argon` | `argon` | `flash` |
| `devteam-muse` | `wonder` | `wonder-full` | `wonder` | `spark` |

These are source defaults, not a current recommendation or a promise those models are offered on every machine. Honour the user's choices, project model-placement rules, installed catalogs and eligible accounts. The creation preview lets the user repair unavailable choices. Each template sets coordinator spare credits to 10 and report spare credits to 0; a spare value is not the total team grant. Planning adds the reports' seats and grants to the parent's allocation. Quick chat defaults to that coordinator and its tier.

## Carry one piece from request to evidence

1. **Record and assign.** Search the docket before creating an item. Keep the problem, requirements and rulings in its description, with one owner and an honest current status. Distinguish an idea being recorded from authorization to implement it. The coordinator assigns concrete work and dependencies instead of creating duplicate owners.
2. **Implement and verify.** The implementer writes coherent changes and checks them using the strongest relevant, authorized method. Contributions from another author are inputs to inspect and verify. Report what actually ran, counts, failures and limits; an intended check or a skipped run is not a pass.
3. **Use the agreed review flow.** When the project calls for independent review, give the redteam the exact committed result and requirements. Reproduce findings, have the implementer fix or reject each with evidence, and verify the affected result. A review of an earlier SHA does not approve later edits. Follow the current project phase, assigned reviewer, waivers and stop instructions: the presence of a redteam seat does not override a user instruction to use author tests only.
4. **Keep the record and handoff true.** The curator maintains source-backed guides and the durable work record. Record committed, reviewed, integrated, built, installed and observed-working claims separately. The implementer owns assembling its deliverable, but the assigned project integrator may reserve shared-branch integration, releases, restarts or live writes; follow that assignment rather than assuming either role grants those powers.

In this repository, development work uses isolated owned worktrees and a single queued heavy build/check/test phase at a time. Take the assigned build lock only for an authorized phase, use its current resource and output rules, then hand it to the next owner and message them. This is a development-team operating practice, not a product setting automatically installed by a template. Use the existing lock and evidence pages below for the current mechanics.

## Start small and adapt deliberately

For a new org, choose a starting layout and inspect its preview. The coordinator's kickoff introduces the team and asks what to build first; the creation form can omit that first message. The template does not supply substantive kickoff tasks to the other three roles, so the coordinator must give them actual assignments when needed.

The implementer charter also supports working alone. Reuse existing expertise before adding seats, keep an idle expert when capacity permits, and retire or rehire according to actual staffing needs. If parallel pieces need separate authors, keep one owner per piece and an explicit integration responsibility. Do not copy a model table or inherited charter over newer project instructions.

To reuse a proven layout, suggest **Save as template**. Its include choices and portability limits are documented in the app guide: saving a layout does not copy mail, docket items, transcripts, watchdogs or audiences. Review accounts and folder grants on the new machine rather than assuming a saved layout can run unchanged.

Ground truth: `engine/docs/templates/devteam-{claude,codex,antigravity,muse}.json`, `engine/docs/charters/{coordinator,implementer,redteam,curator}.md` and `engine/rs/orgtree-engine/src/domain/templates.rs` at `6b77891`. The role pattern does not authorize applying another org's private workflow or local review rules to a new project.

## See also

- [orgtree-committee-mode](../committee-mode/SKILL.md)
- `orgtree-tool-hire` and `orgtree-delegating` (orgtree-working › team): staffing and one accountable owner per piece.
- `orgtree-tool-message` and `orgtree-tool-audience` (orgtree-working › mail): coordinate within actual reach and authority.
- `orgtree-tool-work` (orgtree-working › docket): descriptions, ownership, status and evidence.
- `orgtree-tool-watchdog` (orgtree-working › watchdogs): wait without polling.
- `orgtree-builds-under-the-lock` and `orgtree-reviews-and-landing` (orgtree-working › workspace): authorized build phases and exact-commit evidence.
- `orgtree-org-templates` (orgtree-app › org-settings) and `orgtree-create-organization` (orgtree-app › app-shell): save, inspect and adapt layouts.
