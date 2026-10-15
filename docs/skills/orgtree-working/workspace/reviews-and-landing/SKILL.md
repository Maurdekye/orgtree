---
name: orgtree-reviews-and-landing
description: "Hand off an exact reviewed commit with reproducible checks and precise integration claims."
---

Up: [orgtree-workspace](../SKILL.md)

# Review a concrete result

This is the development team's landing practice, separate from product-side docket permissions. Finish the scoped change, commit it, and give an independent reviewer the exact SHA, stated requirements, changed files, source anchors and relevant verification. Review of an earlier draft does not approve later edits automatically. Use the assigned reviewer and bounded review scope; do not invent extra review rounds after a user waiver or stop.

Keep engine, desktop and visual changes in separate commits as required by this repository. Include documentation/`AGENTS.md` maintenance for a new invariant or ruling in the landing it describes. Do not put private machine/account details into public repository notes.

## Integrate the reviewed change

For current Rust-engine work the coordinator integrates; writers hand in branch and commit list. Do not push `rust-engine` or a branch based on it. Builds, installs, releases and live writes require the coordinator's explicit assignment. The older 3.x `approve_stage`/push workflow is not a current Rust tool protocol.

When an integrator requests a rebase, use the exact new base and examine `git range-diff`. Explain substantive changes instead of describing a different tip as the same review. Re-run the relevant targeted checks when the rebase or a fix can affect their result. Do not replace an authorized source-only review with a claim of product execution, or launch prohibited heavy work just to fill an evidence template.

## Evidence the next reader can trust

State what you ran and saw, what you checked only in source, and what is inferred or unverified. Include source/commit identity, the check command, actual executed counts, failures and evidence location. Zero executed tests is not a pass. A surprising pass needs a control that demonstrates the check can detect the fault when that verification is required.

Keep claims distinct: drafted, committed, source-approved, integrated, built, installed and observed working describe different evidence. An installed build containing a commit does not establish the feature works. A timed-out mutation may already have applied; re-read before repeating it.

Update the existing docket with the complete current outcome and remaining limits, preserving its owner when it belongs to someone else. Put durable rulings in its authoritative description. Report done or blocked through the status tool and send the assigned integrator the exact hand-in. Use [docket review and attention](../../docket/docket-review-and-attention/SKILL.md) for the product's review/attention distinction.

## See also

- [orgtree-docket-review-and-attention](../../docket/docket-review-and-attention/SKILL.md)
- [orgtree-worktrees-and-git](../worktrees-and-git/SKILL.md)
