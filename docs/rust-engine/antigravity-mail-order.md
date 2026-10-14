# Antigravity mail and tool row order

An Antigravity tool-only turn could keep adding new tool chips above mail that
had already been delivered. `on_agy_step` uses `codex_row` to group tools into
an assistant row. `commit_agy_steer` appended the delivered-mail row but retained
that cached assistant row, so later new tools amended the row before the mail.

After a successful mail commit, clear only `Turn.codex_row`. The next new tool
then creates an assistant row after the mail. Existing `tools` and `rows` maps
stay intact: completing a tool that started before the mail updates its original
chip, rather than duplicating or moving it. Repeated mail deliveries each create
the same boundary. No renderer sort, old transcript migration, new interrupt,
process restart, wake rule or passive-notice rule is introduced.

## Measured diagnosis and limits

The October 14 report initially suspected missing delivery. A consistent,
read-only backup of the affected CLI conversation disproved that: all four
mail handoffs were actual user-message steps at indices 13, 14, 25 and 28,
followed by model steps 15, 15, 26 and 29. Three were passive notices. The
driver's PreInvocation/PostInvocation hooks inject `userMessage` steps; they
do not interrupt the turn. See the [official hook documentation](https://www.antigravity.google/docs/hooks/).

The engine acknowledges a hook's local `emitted.json` receipt. That alone does
not prove consumption; in this incident the independent CLI trajectory also
confirmed insertion. Neither receipt proves instruction compliance or the exact
remote model request. Model obedience remains unproven. The temporary conversation
backup was deleted after diagnosis; content-free step indices and hashes remain
in local evidence. No live account or running agent was changed.

## Synthetic regression and hand-in

Run `node tools/rig/rig.mjs run tools/rig/proofs/agy-mail-order.mjs` with the
contained synthetic rig. It uses the real engine, mail handoff and invocation
hook, plus scripted tool events; no shell command or real inference runs.
The proof holds a tool active across a waking delivery, starts a new tool after
that mail, then completes the old tool on its original row. A second, passive
delivery tests a second boundary. Eight checks cover both sequence inequalities,
stable chip ownership/completion, hook receipt, notice flags and a single turn.
Middle and final durable rows are saved as evidence.

Red control: run the same proof and fake CLI against predecessor `a47bb16`.
Exactly the two ordering checks should fail: all four tools formerly shared the
pre-mail row. Keep every other assertion, including in-flight completion.
Green: all eight checks pass, plus existing `agy-lane.mjs` (27 checks).
At source hand-in only JavaScript syntax and diff checks have run; compiled
red/green and lane checks belong to rig-opus's next batch.
