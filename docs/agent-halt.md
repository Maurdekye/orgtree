# Halt and interrupt

User invariant, 12 September 2026: **“A turn cannot run while its agent is halted.”** See [the permanent user decision](v2-user-decisions.md).

Interrupt sends the existing provider interrupt signal and returns immediately. Its resulting boundary may deliver mail, apply a queued model switch, or start another turn. This behavior is unchanged.

Halt persists `node.halt.phase = halting` before terminating the provider process tree. That phase immediately closes admission and mail delivery. The request waits without holding the document lock for the complete turn worker, including accounting and finalizers. Only then does it persist `phase = halted` and return `halted: true, settled: true`. If cleanup has not settled within the bounded wait, the receipt says `halting: true, halted: false, settled: false`; it is not a successful halt. Admission remains closed. Repeating halt finishes the settlement check; unhalt refuses while a worker still owns cleanup.

Halt and unhalt are exposed through `/api/orgs/{slug}/nodes/{nid}/halt`, `/unhalt`, the `orgtree_halt` and `orgtree_unhalt` tools, and the agent desk. Agent tools require authority over a descendant; they cannot halt or release their own caller. The operator retains direct control. Their operation receipts distinguish the durable lifecycle effect from the later receipt transaction.

## Pending work and admission

The durable halt record is independent of live/archived state, provider failure freezes, process warmth and reported working status. Runtime flags are only cancellation aids. The durable record is the admission authority, including after runtime state is forgotten.

Queued carriers are copied into `halt_queue` with stable identities before their runtime copies are removed. Commands retain their command flag and original text. Mail carriers retain their delivery-journal tokens; the corresponding unread batches cannot be discarded or reboxed alongside those carriers. Mail newly arriving while halted stays in the mailbox. Delivery claims and provider acknowledgements cannot mark mail read while a halt owns the agent. Existing uncertain provider handoffs retain their uncertainty; the system cannot claim that an unacknowledged remote request was never received.

Explicit unhalt admits one owner for the preserved work, under the ordinary lifecycle and account gates. Repeating unhalt cannot create another turn. An agent with no waking work remains idle; passive notices retain their ordinary no-wake behavior. A canceled active turn is not automatically replayed if its input was already confirmed delivered. Input not yet confirmed and queued commands remain pending.

| Path or lifecycle operation | Halt behavior |
| --- | --- |
| Manual drive, user/agent mail, passive notices, commands | Admission defers; mail remains unread; commands and waking intent are durable. |
| Worker startup, turn-slot wait, deploy wait, queue follow-up | Gate checked at admission; waits cancel; follow-up cannot run. |
| Claude boundary feed and steering hook | No new feed or claim; queued carriers remain preserved. |
| Codex/Antigravity start, steering, callbacks | Provider handles are terminated; no delivery confirmation while halted; new drives pass the same gate. |
| Watchdog events | Events can still be recorded as durable mail; they cannot start a turn. |
| Checkups and docket reminders | Automatic admission refuses; no synthetic second turn. |
| Process warming and manual process start | Durable halt closes process eligibility. |
| Restart or import recovery | Halt survives; old active intent is not replayed while halted; preserved pending carriers remain durable. |
| Retirement and rehire | Halt follows the same agent through archival and rehire; rehire alone cannot release it. |
| Move, rename, retool, model/account change | Halt follows the agent. Rename waits until halt has fully settled so it cannot hide an active owner under an old name. Other holds can change independently; none removes halt. |
| Cheap compaction, reseed, provider change | The successor retains halt and pending work. An archived predecessor does not receive a copy of the pending queue. |
| Manual provider compaction | Refused while halted. A compaction already active is included in settlement. |
| Remote control | The managed remote-control process is terminated and settled, including a concurrent start. Starting remote control while halted is refused. A stale record without process ownership refuses halt rather than claiming settlement. |
| Unstick or automatic provider resume | Cannot release halt. Other freeze state retains its own owner. |

The backend tests cite the user invariant directly and exercise delayed cleanup, admission races, restart, unread delivery journals, and lifecycle changes with isolated data and fake provider processes. Headless renderer tests cover the distinct controls and truthful labels.
