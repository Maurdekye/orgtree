# Antigravity provider integration and remaining parity

Checked 13 September 2026 against agy 1.2.2.

## Implementation

The integration closes three Orgtree adapter gaps using existing CLI interfaces:

- **Google API-key accounts:** register a Gemini API key in the shared account panel; select it per agent, or use the existing provider-wide API routing controls. Keys stay in the machine token store. A separate settings-only home selects `modelProvider: gemini`; the key reaches only the chosen CLI environment, and generated MCP children have key variables cleared. The lane requires Gemini models and can launch without a subscription login. Automatic paid fallback remains off by default and requires fresh applicable subscription-limit evidence when enabled. Turning subscription inference off selects an enabled API account, if available.
- **Mid-turn steering:** PreInvocation/PostInvocation hooks accept the existing durable mail queue. PostInvocation can continue the run. The driver commits delivery only after hook emission and a new CLI user-input step, before releasing later model output. Late or unaccepted mail stays queued; interruption kills the process tree.
- **Warm processes:** persistent stream-json stdin supports prewarming without a prompt, multiple turns in one process, and the shared warm pool's claim/park/stop lifecycle. Process identity includes account/key fingerprint, model, generation, instructions, hooks/plugins, rights and environment. A mismatch replaces the process. Existing process controls and warm-enable settings apply.

Explicit account changes and automatic changes between subscription and key billing start a new native session while preserving the previous conversation as a readable predecessor. They create a new cache namespace. Usage is reset per turn; cumulative result totals are differenced on subsequent turns of a warm process. Observed requests are priced in their own context bands.

Implementation sequence: establish the CLI contracts with live probes; add shared account/startup preparation; implement persistent driver and acknowledged hooks; connect pool, delivery and metering; validate isolated integration and real CLI behavior; land the tested branch.

## Verification and precise limits

The new focused process and supervisor suite covers 16 cases: same-process turns, cumulative usage, delivery ordering, interruption, secret isolation, prewarm/claim, account switching, rights changes, no-subscription key startup, and consent/freshness conditions for fallback, and failed-key-turn spend/limit attribution. Existing account, routing, registration, hook, provider and transcript suites also pass. Renderer account/model-switch tests and TypeScript typechecking pass.

A live test of the new adapter on installed agy 1.2.2 kept PID **37300** and one conversation across prompts: it remembered **persimmon**, then accepted a correction and returned **REVISED** within a single final-result boundary. The process was closed after the test.

Limits relative to full parity:

1. Steering is accepted at invocation hooks; it cannot interrupt an in-progress model generation immediately.
2. API-key plumbing and isolation were tested with fake credentials and isolated child processes. No real paid Gemini key was supplied or billed, so a successful paid provider request remains unverified. Vendor documentation explicitly supports this authentication path. Model availability and validity are finally decided by Google.
3. Displayed spend is a local token-price estimate, not an invoice. It does not observe account free-tier credits, non-token charges or invoice adjustments. Result-only usage after a cold resume retains the adapter's existing cumulative-counter limitation when no per-request usage is available.
4. Warm local processes do not establish provider cache hits or a TTL. The live probe reported zero cached reads.
5. Secondary concurrent subscription accounts are still unsupported. No login tokens were copied, switched or modified.

Sources: [API-key authentication](https://www.antigravity.google/docs/cli/install/), [headless stream protocol](https://www.antigravity.google/docs/cli/headless/), [invocation hooks](https://www.antigravity.google/docs/hooks/), [Gemini token pricing](https://ai.google.dev/gemini-api/docs/pricing).

## Secondary subscription accounts

**Impossibility is not established. A supported native way to isolate concurrent subscription identities is still missing.**

The latest public CLI release verified is **1.2.2**, published **12 September 2026**. Its release notes include Gemini API and session-memory fixes, but no account selector. The installed binary is already at that release. [Release 1.2.2](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.2.2).

**Upstream issue #381** requests precisely an auth-profile/store selector for wrappers and concurrent headless accounts. It remains open without a delivered interface or published schedule. Related open reports cover container credential persistence (#479), Linux keyring prompts (#547), and a Windows startup authentication race (#913); older reports are leads, not reproduced failures on 1.2.2. [#381](https://github.com/google-antigravity/antigravity-cli/issues/381), [#479](https://github.com/google-antigravity/antigravity-cli/issues/479), [#547](https://github.com/google-antigravity/antigravity-cli/issues/547), [#913](https://github.com/google-antigravity/antigravity-cli/issues/913).

Redirecting HOME/USERPROFILE changes settings but did not isolate Windows subscription authentication in the local probe. Windows credential lookup follows the process's logon context. Community managers demonstrate account switching; a Windows wrapper claiming concurrency swaps the shared credential under a launch mutex that is released before agy runs. Its source does not guarantee isolation across token refresh, logout, restart or overlapping launches. This is a source-based inference, not a reproduced exploit. [Windows credential lookup](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw), [pinned community launcher](https://github.com/lcizzle/multigravity-win-cli/blob/d93bd0ce5f7267ed35d40679b2aeab1c9ad241c8/multigravity.ps1#L1649).

| Route | Work and estimated effort for one experienced engineer |
| --- | --- |
| Upstream native selector | Once available, 5–10 engineer-days for login, launch, usage and identity checks. Upstream delivery unknown. |
| Separate Windows users and a process broker | 2–4 days feasibility, then 15–25 days conditional integration: login under each identity, IO/process broker, workspace ACLs, MCP, usage, cleanup and upgrades. Strongest local candidate. |
| Separate Linux/WSL environments and keyrings | 2–4 days feasibility, then 10–20 days if persistence works; Windows tooling/path integration changes substantially. |
| Serialized shared-keyring switching | 5–10 days for a limited feature. Does not meet simultaneous-account parity. |
| Credential API virtualization or binary patching | 1–2 weeks investigation; potentially 4–8+ weeks production work with continuing compatibility costs. No proven implementation. |

A valid proof must run two authorized accounts concurrently across refresh, process restart, logout/revocation and crashes, while preserving the ambient user's account. A successful startup for each account is insufficient. Separate Windows identities require validation of the exact logon type and process broker. [Windows process launch](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw).

## Remaining provider gaps

These are researched differences, not additional implemented features. Estimates include focused testing and remain conditional.

| Area | Remaining difference and next work |
| --- | --- |
| Rights coverage | Static tool-name restrictions may lag newer documented tools/actions. Audit installed inventory and all four scope switches: 1–3 days. No bypass was reproduced. |
| Read-only shell and folder enforcement | Read-only seats currently lose shell access. Native sandbox docs cover Linux/macOS; Windows parity is unverified. 2–3 days feasibility; 1–2 weeks native mapping or 3–6 weeks a Windows helper. |
| Compaction/fork | Interactive `/fork` exists, but a supported headless fork door is unproven; Orgtree normal compaction is refused. 1–2 days probe; 3–6 days summary-to-fresh-session handoff, or 1–3 weeks native integration if supported. |
| Images | Streaming input accepts text; existing file-view fallback needs an extra tool call. 1–3 days reliability improvements; true inline parity needs another transport or upstream support. |
| MCP settings and runtime inventory | Basic stdio/HTTP works; optional settings are omitted and loaded-tool inventory is unresolved. 1–2 days probe, 2–4 days settings mapping, 3–7 days inventory if the CLI exposes it. |
| Cache expiry | Hit-token receipts exist, but no authoritative TTL. 1–2 days label/receipt audit; a reliable expiry estimate depends on upstream evidence. |
| Model/effort catalogue | Fixed Flash/Pro mappings and translated effort values. 2–5 days version-aware discovery and effective-value display, plus pricing checks. |
| Embedded subscription login | Current login opens an external Windows terminal. 1–3 days better lifecycle/recheck UI; embedded login needs a verified auth interface. |

Sources: [permissions](https://www.antigravity.google/docs/cli/permissions/), [sandbox](https://www.antigravity.google/docs/cli/sandbox/), [conversation operations](https://www.antigravity.google/docs/cli/conversations/), [headless input and output](https://www.antigravity.google/docs/cli/headless/), [MCP configuration](https://www.antigravity.google/docs/cli/mcp/), [execution modes](https://www.antigravity.google/docs/cli/modes/).

The next engineering investigations should be rights/tool coverage, headless compaction and MCP inventory, alongside a separately scoped Windows identity-broker proof.

