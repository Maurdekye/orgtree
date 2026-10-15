# Mail input budgets and reference delivery

## Problem and delivery contract

A Codex `turn/start` rejected a queued-mail input exceeding 1,048,576
characters. The claim was returned to pending, so fresh sessions and later wakes
composed the same oversized input. The terminal-launch notice was suppressed
after the first failure in a run.

The engine now measures rendered mail, including sender headers, quoted reply
context, typed event text and attachment descriptions. A rendered item over
65,536 UTF-8 bytes becomes a reference with a preview of at most 1,024 bytes,
its original sender/notice/authority framing, its mail id and explicit
`orgtree_inbox` fetch/chunk instructions. Exactly 65,536 bytes stays inline.
Both opening and mid-turn forms count toward the per-item threshold. Original
mail bodies, replies and attachments in the database are never rewritten.
Reference delivery is acknowledged by the same acceptance rules as inline mail.
Images on referenced mail are fetched on demand, rather than loaded implicitly.

## Final text limits

| Actual harness process | Engine text budget | Evidence / limit |
| --- | ---: | --- |
| Codex app-server, including OpenRouter/local Codex routes | 1,000,000 UTF-8 bytes | Observed refusal at 1,048,576 characters; 48,576 units of headroom |
| Claude Code stream-json, including gateway routes using Claude | 262,144 UTF-8 bytes | Conservative policy; native maximum not verified |
| Antigravity | 262,144 UTF-8 bytes | Conservative policy; native maximum not verified |
| Muse MSP | 262,144 UTF-8 bytes | Conservative policy; native maximum not verified |
| OpenCode ACP, including OpenRouter/local ACP routes | 262,144 UTF-8 bytes | Conservative policy; native maximum not verified |

UTF-8 bytes upper-bound Unicode scalar and UTF-16 character counts. This is a
bound on the final text sent for a turn/steer/hook, including its wrappers and
dynamic context. It is not a model token-window guarantee, a total-history
bound, or a change to binary image transport limits. Claude's official error
reference could not be retrieved during author diagnosis; third-party mirrors
were not treated as proof of an installed Claude limit. Unknown limits are
explicitly conservative, not asserted native limits.

A common composer selects only an ordered prefix of each claim (opening claims
up to 64; steering claims up to 32). It measures
the exact final string before admission. If the first item still cannot fit,
it uses a reference without a preview. A locally unrepresentable context or
reference fails before any send and returns the unsent claim to pending.

Unselected rows return to pending with their original ids/order and no delivery
acknowledgment. A per-mail `extra.input_budget_deferred` marker lets the admitted
passive tail continue on subsequent turns. This does not make unrelated new
passive notices wake an agent. Normal halt/freeze/killswitch/admission checks
still apply. A waking item beyond the first 64 rows admits the older prefix
without being claimed out of order; it remains pending for a later turn. Deferral logs contain selected/deferred counts, candidate/selected
byte sizes and the budget, never message bodies. No global lock is added;
composition and filesystem work run after the claim transaction commits.

## Oversized context

The generated dynamic org-state/provider-usage envelope and the handoff each
have a quarter of the lane's budget. An oversized generated envelope is retained
at a uniquely created `orgtree-turn-context-<uuid>.txt` in that agent's **own**
scratch and replaced with an instruction to read it. Files inherit the owned
scratch's Windows access controls (0600 on Unix). They remain available as
ordinary own-scratch artifacts; no shared/team path or automatic deletion.

Only the already-generated org state and usage text can reach these new files.
Identity, charter, standing notes, credentials/config sources, mail bodies and
attachment contents are not passed to this writer. It does not read auth files.
An oversized handoff is NOT copied there: it points to the full own conversation
already saved by the existing handoff path, or to own transcript/inbox reads.
The handoff's history path is preserved when present. This avoids making a new
copy of arbitrary conversation contents under the context filename.

## Recovery and repeated stalls

Old queued mail uses the new composition on the next normal wake; no compact,
mail deletion or manual repair is needed. The current queue remains authoritative.
A length refusal carries text byte/character sizes and the selected lane budget.
Each actual refused launch is announced even when `hard_fail_run` is already
nonzero, with its attempt count. Other terminal errors retain once-per-run notices.
Launch failures already have no timer retry. Input-length failures after a turn
is accepted also bypass network/context-reset retries and automatic follow-up
redrives, even if a passive budget tail remains; they wait for a new wake.
This prevents notification/retry loops. A completed turn clears the failure run.
The typed launch notice supplies the agent name; only sizes are recorded in the
new composition logs. Body-bearing rendering helpers opt out of argument logging.

## Verification and limits

Red tests were committed before product changes: original `e3a4bf5` on `7b7dd2e`,
rebased as `ba697bd` on `4447424`. The two red cases cover a giant body on
opening/replay/steer paths and a giant quoted reply. Expected red: 2 failures.

Final `runtime::prompt::mail_size_tests` has seven cases: those two plus exact
threshold/attachment metadata, ordered multi-batch delivery on both composition
paths/ceilings, final-budget/reference-only/multibyte edges, owned-context storage
and handoff pointers, and terminal length-error classification.

`tools/rig/proofs/mail-input-budget.mjs` contains 24 runtime checks:
- giant mail + old failure state on five harnesses;
- full original recovered through inbox fetch/chunk;
- many medium messages split in order, including passive-only tails, on Codex
  and Claude, with original bodies unchanged;
- ordering across the 64-row claim boundary with 70 notices and a final wake;
- oversized native Codex steering;
- repeated length refusals after halt/unhalt, size-bearing notices, no automatic
  retry after either refusal, and recovery on the next ordinary wake.

Use the **candidate fake CLI with both candidate and base engines**. It enforces
Codex's observed input field ceiling and records safe Muse/ACP input sizes. The
base runtime proof is expected to show 14 failing assertions and 10 controls;
these are predictions until the rig measures them. Baseline is `4447424` (or
`7b7dd2e` if explicitly attributed; relevant runtime behavior is unchanged).
Run the existing `launch-failure.mjs` and `mailbox.mjs` regression proofs too.

Author validation: Rust parse checks, Node syntax check and `git diff --check`.
Compilation, unit and runtime red/green verification belong to rig-sol-b. No real
profile, reporting-org mailbox, model call or production data was accessed.
