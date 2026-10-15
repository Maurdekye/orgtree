---
name: orgtree-tool-usage
description: Read Orgtree's cached account usage or request one permitted, rate-limited account refresh.
---
Up: [orgtree-accounts](../SKILL.md)

# orgtree_usage

Use this tool during a turn to inspect account usage without waiting for another turn's usage board. Its default is a saved-cache read. It does not select an account, change a binding, add capacity, or prove that an unread account has room.

## Access and scope

Requires the inherited **inspection** tool group. `refresh: true` additionally requires inherited **runtime** permission. Top-level and nested agents follow the same checks; top-level position grants no exception.

Results cover only accounts allowed by the caller's org account list and origin restrictions. Inactive accounts remain inspectable with `enabled: false`, but cannot be refreshed. There is no show-all-accounts or other-org override. Native sign-ins use canonical IDs such as `openai/primary`; registered accounts use their registry IDs, OpenRouter keys use `openrouter-N`, and language servers use `langserver:<server-id>`. Use the IDs returned by the tool, not email, account label, credential path, or display nickname.

## Parameters

All parameters are optional; the minimal call is `orgtree_usage` with:

```json
{}
```

| Parameter | Type, default, and behavior |
| --- | --- |
| `accounts` | Array of 1–32 exact account IDs; omitted selects all permitted lanes. Every explicitly named ID must be available in this org's query scope. |
| `providers` | Array of 1–32 canonical provider IDs: `claude`, `openai`, `google`, `muse`, `openrouter`, `langserver`; omitted selects all providers in scope. |
| `windows` | Array of 1–32 exact window selectors; a selector matches canonical `kind` or exact provider `group`, not its display label. Omitted selects all windows. |
| `refresh` | Boolean, default `false`. `true` selects exactly one explicit active account, with no cursor, and attempts its ordinary usage reader. Other filters must still select that account. |
| `limit` | Integer from 1 through 100, default 20; number of accounts per page, not windows. |
| `cursor` | String of at most 256 UTF-8 bytes, returned as `next_cursor` by the previous page; omitted starts at the beginning. It must still identify an account in the current permitted inventory. |

Each selector string must be nonempty and at most 256 UTF-8 bytes. Duplicate selector values are collapsed. Explicit empty arrays refuse; they do not mean “all.” Matching is exact: OR within one array, AND across dimensions. Unknown arguments and invalid types refuse.

Example: read the saved Google Gemini windows:

```json
{"providers":["google"],"windows":["gemini-5h","gemini-weekly"],"limit":20}
```

Accounts sort by stable account ID. Continue with the returned `next_cursor` and the same filters. Pages are current reads, not a frozen multi-page snapshot. A window filter can leave an account with no matching windows; it does not remove the account or conceal its unavailable status.

## Read the response

The outer object contains `as_of`, `cache_only`, `accounts`, `next_cursor`, and `refresh`. `refresh` is null for an ordinary cache-only call. `cache_only: false` means a refresh was requested, even if it reused a reading or met a cooldown.

Account rows identify `account`, `provider`, `enabled`, `own_account`, `source`, `available`, `reason`, `freshness`, `observed_at`, `age_seconds`, and `windows`. `own_account` uses the account captured for this running turn; a queued move is not substituted for it.

- `no_cache` means no reading; `failed` means the read failed; `signed_out` identifies current negative sign-in evidence. `unknown_observation` means the observation cannot be dated safely.
- A dated observation under 900 seconds old is `fresh`; at 900 seconds it is `stale`. Stale successful windows can remain visible, dated, while `available` is false. Freshness and limit state are separate.
- Null means unreported. Unavailable, stale, missing, and unsupported are never a measured zero or proof of room. Newer sign-in evidence can change availability without re-dating old quota bars.
- Each account exposes at most 64 matching windows, with `window_count` and `windows_truncated` when supplied by its projection. Follow account pagination separately; there is no second page of windows.

A window can contain `kind`, `group`, `model`, `label`, `used_percent`, `amount`, `unit`, `resets_at`, `reset_in_seconds`, `limited`, `marked`, and `state`. `limited` follows the reported percentage/full-state; `marked` reflects stored account marks. State is `limited`, `marked`, `ok`, or `unknown`. A reset countdown is a reported deadline, not evidence that a new reading has arrived.

Non-OpenRouter API-key rows report local metered spend, with provider quota `unsupported`; `no_recorded_spend` is distinct from zero and a database failure. A language-server row reports unsupported quota and its `concurrency_cap`, not a fictitious usage percentage. OpenRouter uses its key's credit standing; do not infer a rolling reset that the provider did not supply.

## Optional refresh

For an active permitted lane, a refresh request looks like:

```json
{"accounts":["openai/primary"],"refresh":true}
```

The ordinary reader may reuse its cache, perform a bounded HTTP metadata read, or launch its provider's bounded metadata probe. It makes no inference request, changes no account, and does not refresh an OAuth token. Existing successful-reader effects such as usage-history recording and account-mark processing still apply. Default cache reads perform none of those probe/history/mark effects.

Manual refresh attempts, including failures, share a per-lane floor across callers: 60 seconds, or 300 seconds for Google. A reading younger than that floor can be reused. Longer provider cooldowns remain, including Claude retry-after and Codex's app-server fallback cooldown. An existing read owns the shared reservation: a second caller gets `in_progress`, not a queued duplicate request. A local-server refresh is `unsupported`; API-key refresh reads local spend.

Read `refresh.status` and `retry_after_seconds` where present:

| Status | Meaning |
| --- | --- |
| `attempted` | The permitted reader succeeded; this alone does not prove a new provider observation or fresh bars. |
| `reused` | A recent reading was retained without a new manual probe. |
| `rate_limited` | A manual floor or provider cooldown prevents another attempt. |
| `in_progress` | A read for that lane already owns the reservation. |
| `unsupported` | No refresh reader exists, as for a local-server quota. |
| `failed` | The reader failed or current negative authentication evidence prevents success. Old observations retain their dates. |

Do not loop on a cooldown. Use cached evidence and the retry hint; settings or credentials are not repaired by repeated refreshes.

## Refusals and recovery

- `orgtree_usage is disabled by your Orgtree tool group scope`: inspection was denied through current inherited scope.
- `unknown usage query argument`, invalid selector/type/provider errors, or `limit must be an integer from 1 through 100`: correct the request rather than widening it.
- `requested usage account is unavailable to this organization`: unknown and out-of-scope explicit IDs share this refusal. Obtain a permitted ID; there is no cross-org bypass.
- `refresh requires exactly one explicit account and no cursor` or `refresh filters must select the explicit account`: narrow the request correctly.
- `fresh usage needs inherited runtime permission`: use a cached read or ask the superior for the required capability.
- `inactive accounts can be inspected but cannot be refreshed`: explain the inactive control to the user; this tool cannot activate it.
- Permission/account-scope changes during an await can refuse the result with a corresponding `usage ... changed` message. Re-read current scope before a revised call; do not assume the old grant still applies.

Use [account-mark](../tool-account-mark/SKILL.md) to inspect a stored capacity mark; a usage refresh is not an instruction to clear one manually. Use [continue-on](../tool-continue-on/SKILL.md) only for an authorized account move.
