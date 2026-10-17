---
name: orgtree-iterative-development
description: Alternate fast specification feedback with explicit release hardening, while keeping release lines and delivery evidence clear.
---

Up: [orgtree-collaboration-patterns](../SKILL.md)

# Specification, feedback and hardening

Use this suggested workflow when the user needs working builds to settle a design
and then wants a thoroughly checked release. The coordinator records each release
line's current phase, scope, owner and next gate in the docket. Different lines
can be in different phases at the same time. Agree on the process with the user;
reading this page does not authorize a build, install or publication.

## Phase 1: specification and feedback

The user supplies ideas, tries builds and reports design or bug feedback. Keep
the loop short:

1. Record the concrete request and its assigned release line. Give each piece
   one accountable owner.
2. Authors implement and run their own focused checks, using a failing control
   first where it fits. They send the coordinator the exact commit SHA, results
   and remaining limits.
3. The coordinator integrates the changes. The authorized builder produces an
   alpha and runs a quick smoke check, then delivers it for user feedback.
4. Record that feedback and repeat until the user has seen all the feedback
   they want and explicitly requests hardening.

This phase uses author checks, with no independent reviewer and no combined test
round. Author checks still need to exercise the change. The presence of a review
seat in the team does not itself change the phase.

## Phase 2: refinement and hardening

Enter only on the user's go-ahead, once the line is feature-frozen and the user
has finished the feedback they want. The coordinator announces the switch and
records the frozen scope. A quiet inbox or a completed alpha is not that go-ahead.

The team now performs static review, assigns an independent reviewer to each
exact committed change, and fixes or resolves the findings with evidence. Run
the full combined test round for the integrated release candidate. Compare its
failures with known failures on the base; keep both records and distinguish new
regressions from existing failures. A skipped or crashed check supplies no pass.

Prepare the release notes and version commit, check the final candidate, and
publish through the designated release owner within the user's authorization.
If review or implementation raises a question that needs the user, return that
line to phase 1 for clarification and feedback. Resume phase 2 only after a new
go-ahead. Record the transition so authors and reviewers use the same rules.

## Release lines and feature freeze

Keep a patch line for fixes, documentation corrections and minor tweaks, and a
feature line for larger work. State the target line in every assignment. A
feature-only ticket starts from the feature line. A ticket for both starts from
the current patch-line tip; the coordinator integrates there and merges it
forward into the feature line, preserving both lines' changes.

Feature freeze closes the release scope to new features. Put new feature work
into the next release or backlog; keep only fixes and explicitly retained work
on the frozen line. Record any narrower list of permitted last fixes. Returning
to feedback for a question does not silently widen that recorded scope.

Once the release is confirmed, close its line for this workflow. Every newly
reported bug fix targets the next line, including bugs discovered in the released
version. Update assignments and bases accordingly instead of continuing to land
new fixes on the closed line. Record an explicit user decision if the project
adopts a different maintenance policy.

## Deliver each build with evidence

The builder hands over the installer path, its SHA-256 and a concise change list,
with the version and source SHA identifying what was built. Use the project's
designated artifact location and keep the build/smoke receipts. Keep built,
delivered, installed, user-observed and published outcomes distinct in the docket.
The user can use the change list to choose what to exercise and send feedback
against that exact build.

The user may let small last fixes proceed without another alpha. Record the
waiver and affected commits. It waives that extra feedback build; the current
phase's checks and the final publication decision still apply.

This pattern comes from the user-approved development phases of 2026-10-16 and
the release-line, final-fix and post-release refinements of 2026-10-17. The team
chooses actual versions, branch names, reviewers, builders and artifact paths.

## See also

- [orgtree-dev-team](../dev-team/SKILL.md): roles and accountable implementation.
- `orgtree-tool-work` (orgtree-working › docket): scope, phase records and evidence.
- `orgtree-reviews-and-landing` and `orgtree-builds-under-the-lock` (orgtree-working › workspace): exact-SHA handoffs and authorized build mechanics.
- `orgtree-tool-send-file` (orgtree-working › user): deliver a wanted installer file.
