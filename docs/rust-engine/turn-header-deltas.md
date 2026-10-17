# Turn header deltas (4.4.0)

The per-turn org chart previously compared rendered ages and periodically forced
full refreshes. Small reports always received the whole org header. Usage
already ignored age ticks and used five-percent steps, but every material change
resent the whole board and becoming stale did not change its key.

The user requested compact deltas on 2026-10-17 (12:55Z); coordinator assignment
m7c56c807d6fe bases this change on local rust-engine b154f2a, for 4.4.0 only.

## Reading a header

The first delivery in a fresh/compacted session contains a numbered full block.
Later deliveries carry either one unchanged-reference line or a numbered DELTA.
A delta replaces only its named facts; other facts still come from the preceding
full block and intervening deltas. Every reference/delta names the last full
snapshot. Removed entries are explicitly identified. Ask `orgtree_chart` or
`orgtree_usage` for an on-demand current full view; these tools are unchanged.

Org keys include visible relationships, status reports, runtime busy/waiting
state, frozen/halted state, credits, audience guidance, open requests and peer
mail policy. Ages are displayed when a fact changes but never cause a resend.
Visibility remains the same as the existing chart and roster; self-only readers
also receive their own safety state. A relationship delta names individual
reports/peers instead of repeating the entire roster.

Usage keys include five-percent bands, reset dates rounded to the nearest minute and whether the reset
has passed (checked at full precision), fresh/stale class, unavailable/unknown state and limit marks. Subsecond
deadline jitter and runtime start-time changes without a sampled busy/waiting
transition do not resend a row. A
100% window and openai-1 weekly >=80% surface immediately. The latter names the
policy restriction; this does not change account eligibility or the user's
separate openai/primary extra-credit ruling. Every usage reference still names
the current account and tier. Cache reads never probe providers, change account
bindings, or imply that reset/staleness establishes available capacity.

All blocks remain in the turn body. Identity, tools and the system prefix are
untouched. The proposed org and usage baselines advance only after the CLI
accepts the turn. Per-entry records retain semantic hashes and labels, not raw
provider documents, status bodies or rendered ages. Accepted records are merged
under `agents.extra.envelope`; usage can reuse its baseline after an actor restart.
A missing record or unknown session conservatively starts with a full block.

## Measurement and tests

Fixtures use synthetic data only: a 33-agent coordinator, a two-agent report
with self visibility, and three cached providers with six windows, each over
40 turns. Measured UTF-8 bytes are exact for these fixtures. Token counts are
inferred as bytes/2, per coordinator m095cc6acfc22; no tokenizer was used.

Before changes (882b580):

| Fixture | Bytes / 40 turns | Full | References | Inferred tokens |
| --- | ---: | ---: | ---: | ---: |
| Org, quiet coordinator | 45,840 | 5 | 35 | 22,920 |
| Org, busy coordinator | 169,250 | 40 | 0 | 84,625 |
| Org, small report | 24,600 | 40 | 0 | 12,300 |
| Usage, quiet | 4,876 | 1 | 39 | 2,438 |
| Usage, one progressing window | 13,484 | 9 | 31 | 6,742 |

The actual product test binary measured five expected failures: org unchanged,
org age-only, org changed-row isolation, small-report reuse and usage freshness.
Four tests passed (one unrelated HTTP test also matched `header_`). Cargo exited
101 with no signal; the outer wrapper rejected the extra passing test count.
All five measurement records and raw statuses are retained under the author's
assigned build scope, `headers/red-*`. This is measured evidence, not an app
build or a live provider test. No 4.4.0 app build is authorized for this task.

Initial focused green at 798072e: 13/13 product tests passed, cargo exit 0,
no signal. The same fixtures measured:

| Fixture | Bytes / 40 turns | Full | Deltas | References | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| Org, quiet coordinator | 5,432 | 1 | 0 | 39 | 88.2% |
| Org, busy coordinator | 9,832 | 1 | 39 | 0 | 94.2% |
| Org, small report | 2,660 | 1 | 0 | 39 | 89.2% |
| Usage, quiet | 4,759 | 1 | 0 | 39 | 2.4% |
| Usage, one progressing window | 5,863 | 1 | 8 | 31 | 56.5% |

These are synthetic fixture savings, not measurements of a live workload.
Quiet usage was already well suppressed; most usage savings come from replacing
changed full boards with individual windows. Initial green artifacts are
`headers/green-*`. The final focused rerun adds runtime timestamp and reset
deadline jitter controls; its verdict is recorded in the author hand-in.
No end-to-end database/process-send failure injection was run: focused product
tests verify the pure proposal/retry formatter, and source inspection verifies
accepted-only persistence in the existing actor send path.
