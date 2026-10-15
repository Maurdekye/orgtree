---
name: orgtree-tool-account-mark
description: Inspect account capacity marks and clear an exact unchanged mark with an audited reason.
---
Up: [orgtree-accounts](../SKILL.md)

# orgtree_account_mark

A capacity mark records that a provider/account pool was limited until a reset time. Use `inspect` to understand that stored restriction. Use `clear` only when the task authorizes removing a specific obsolete or incorrect mark. Clearing adds no provider capacity and resumes nobody; the provider can mark the account again if it still refuses.

## Access and parameters

Both actions require the inherited **runtime** tool group, including read-only `inspect`. There is no top-level-only restriction: top-level and nested agents may act on any registry account visible to their org under its account-list and origin rules. This authority is not limited to the accounts bound to the caller's descendants. It does not expose another org's private key.

| Parameter | Meaning and default |
| --- | --- |
| `action` | Required string: `inspect` or `clear`. No default. |
| `account` | Required nonempty string. Inspect accepts an exact registry ID, label, or email. Clear requires the exact `account` ID returned by inspect. Native-primary usage lanes are not automatically registry IDs. |
| `source` | Clear only; use the returned `source`, currently `registry`. Omitted defaults to `registry`. `legacy-roster` appears in the schema for compatibility but this engine refuses it. |
| `pool` | Clear only, required nonempty string; copy the mark entry's pool. Do not assume every provider/model shares `default` or `pooled`. |
| `expected` | Clear only, required object; copy the mark entry's complete `expected` fingerprint unchanged. It identifies the observed mark. |
| `companion_expected` | Clear only, optional object copied from `companion.expected`; guards the Fable companion against a concurrent change while clearing a pooled/default mark. |
| `reason` | Clear only, required nonblank string, at most 500 characters after trimming; retained in the audit. |

`inspect` needs only `action` and `account`; clear-specific fields are unused on inspect. Required strings are trimmed. Where a label/email is ambiguous, use an exact ID from the permitted account inventory rather than relying on the first match.

## Inspect

Minimal call, using an account visible to this org:

```json
{"action":"inspect","account":"openai-1"}
```

The response contains canonical `account`, display `name`, `provider`, `marks`, and a note that clearing grants no capacity/resume. At most 64 stored marks are returned, sorted by pool, including expired records; there is no pagination parameter.

Each entry includes `source`, `account`, `pool`, `state` (`active` or `expired`), `until`, `until_iso`, `remaining_s`, `observed_at`, `age_s`, `provenance`, `window`, and `expected`. The fingerprint carries `until`, `observed_at`, `provenance`, and `window`; preserve the numeric timestamp precision, not a rounded display time.

For `pooled`/`default`, a stored Fable mark can appear as `companion`, containing its pool, `cleared_with_this` flag and its own `expected` fingerprint. The flag says whether it is the inferred companion with the same reset horizon, rather than an independent Fable restriction.

An empty mark list means no matching stored records were returned. It is not a quota measurement. Use [usage](../tool-usage/SKILL.md) for the provider's cached quota observations.

## Clear exactly what was inspected

Take `mark` from the just-inspected response. The following is a call pattern using that actual entry, not a template for inventing timestamp values:

```javascript
orgtree_account_mark({
  action: "clear",
  account: mark.account,
  source: mark.source,
  pool: mark.pool,
  expected: mark.expected,
  ...(mark.companion ? { companion_expected: mark.companion.expected } : {}),
  reason: "Remove the obsolete capacity mark after checking current evidence."
})
```

The reason must state the real basis for this clear. Do not copy the example reason unless it describes what you checked. Compare-and-set occurs on the stored fingerprint: another write after inspect makes the request stale. If `companion_expected` is supplied and a present companion no longer matches, the entire clear returns `changed` before deleting anything.

| `result` | Effects and next step |
| --- | --- |
| `missing` | No mark for that exact account/pool; `current` is null and nothing is written. Stop or inspect if the wider state is still unclear. |
| `changed` | The target fingerprint or supplied companion fingerprint no longer matches; `current`, and sometimes `companion_current`, show current snapshots. Nothing is written. Inspect again and reconsider the evidence before a new clear. |
| `cleared` | The matching record was deleted and its audit/event committed. `was_expired` says whether it had already expired. `cleared` and `kept` identify the actual records removed/preserved. |

Expired records can be cleared too; the operation removes their stored record rather than creating capacity. A pooled/default clear also deletes an inferred Fable companion with exactly the same reset horizon. An independently observed or differently dated Fable mark is kept and reported. Do not promise that clearing one pool clears every limit on the account.

Every successful clear records actor, org, tool route, account/pool, removed/kept snapshots, time and reason. The delete and audit commit together. The tool then returns `frozen_here`, a read-only hint listing at most 50 live frozen agents in the caller's org explicitly bound to that account; it is not an exhaustive cross-org or ambient-alias affected-seat list.

Those agents remain frozen. If authorized and appropriate, release a descendant separately with [unstick](../../runtime/tool-unstick/SKILL.md), or choose an eligible same-provider destination with [continue-on](../tool-continue-on/SKILL.md). Neither action is implied by clearing the mark.

## Refusals and recovery

- `orgtree_account_mark is disabled by your Orgtree tool group scope`: even inspect needs runtime permission.
- `` `action` is required `` / `` `account` is required `` or `unknown action ... (inspect or clear)`: correct the action and arguments.
- `no account ... is visible here`: unknown IDs and invisible accounts share this response. Inspect a permitted registry account.
- A clear by label/email refuses with `a clear takes the exact account id that inspect returned`; reuse the returned ID.
- `this engine has no legacy roster; every mark is in the registry (source registry)`: use `registry`; a compatibility enum is not an implemented legacy store.
- `clear needs the mark entry's pool`, `clear needs a reason`, `expected must be the ... object inspect returned`, or `reason is limited to 500 characters`: supply the inspected snapshot and a bounded real reason. A malformed object can instead return `changed` because it does not match.

If a mutating call times out or reports an uncertain failure, inspect again before retrying: a clear may already have committed before a later response/read failed. Treat the stored mark and audit as evidence; repeated clears are not a capacity repair.

## See also

- [orgtree-account-lanes](../account-lanes/SKILL.md)
- [orgtree-usage-windows](../usage-windows/SKILL.md)
- [orgtree-usage-freezes](../usage-freezes/SKILL.md)
- [orgtree-cache-continuity](../cache-continuity/SKILL.md)
