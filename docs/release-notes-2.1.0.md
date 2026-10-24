# Orgtree 2.1.0

Changes since 2.0.9. These notes describe the release candidate; publication is pending.

## Accounts and provider usage

- Choose an account when hiring, rehiring, or retooling an agent, including returning an agent from a managed account to the default sign-in. Account defaults also preserve an explicit choice of the primary account.
- Account choices consistently show the account ID and email. The primary sign-in appears as `default`; managed accounts use their immutable IDs. A provider with one available account keeps its choice visible and disables the dropdown.
- The Usage panel shows account IDs and emails for providers with multiple accounts, and the email alone when there is only one. Legacy custom labels no longer replace account IDs.
- Agents receive usage, reset times, freshness, and availability for all registered accounts, with updated guidance for choosing accounts and interpreting provider-specific limits.
- Antigravity usage now comes from its CLI, with account-specific caching and authentication status handling.
- Frozen agents retain the wake time selected from their rate-limit response, including an inferred-time label when appropriate. The displayed estimate and automatic resume use the same stored decision; a stale account roster cannot erase it. The rate-limit-specific retry is consumed only when an attempt is actually sent.

## Agent control and reliability

- Halt and Unhalt provide a durable way to stop an agent. Halt prevents new turns and preserves pending work across restarts and lifecycle changes until the agent is explicitly unhalted. Interrupt remains available for stopping the current turn.
- Recovery handles queued model switches, missing accounts, failed remote drivers, and invalid state transitions more reliably, while respecting a durable halt.
- Lifecycle operations read bounded log data and lighter archive summaries. Large organizations spend less time loading detail that the current view does not need.
- An Antigravity turn that finishes successfully is no longer reported as failed solely because the CLI omitted its final summary.

## Tickets and conversations

- Ticket descriptions support full Markdown without the former 2,000-character product limit. Long descriptions initially show ten rendered lines and can be expanded. Agent guidance now requires descriptions to contain the complete scope of the work.
- Ticket references update when the available ticket names change, while unchanged references keep their existing elements in place.
- Ticket ownership and review assignments follow the same agent through generation changes. Historical authorship stays intact.
- Assigning a backlogged ticket opens it automatically.
- Assistant messages reconcile by identity across streaming events and saved transcripts, reducing duplicate or missing text during refresh and recovery.
- Inline replies show rich previews from the exact replied-to content and retain the shared object context menus.
- Expanded transcript messages stay expanded while new events arrive. Large history views release their expanded window when the reader leaves history, and active searches can still retrieve the full record.

## Desktop and workspace

- The ordinary Agents window stays inside the available canvas height. Long lists scroll internally; pinned and popped-out windows retain their existing sizing behavior.
- Agents List rows expose the same context menu as agent cards, including Pop out. Shared menus also provide copy-name and ticket-title actions, and a ticket menu can open immediately after its slug is copied.
- Close actions now close their corresponding panels and documents consistently.
- Home and each organization retain separate Usage panel state. Organization Settings also keeps its open state per organization.
- Popouts open near the surface they came from and preserve its shape. Canvas controls can be anchored to the space left around pinned windows.
- Choose agent colors by provider or organization, use independent contrast presets, and configure native notification categories and focus behavior.
- Urgent mail, questions, and ticket attention route to the corresponding request. The Docket button is more prominent when attention is needed.
- Toolbar menus, Usage spacing, capitalization, and zoomed-out card badges receive smaller usability improvements.

## Performance and development

- Unchanged organization trees can reuse conditional responses instead of rebuilding and transferring the full view. Invalidation prevents stale results from replacing newer state.
- Background work shares snapshots and scopes process-warming checks to the organizations that changed. Stream identity, closed tickets, and settled logs avoid repeated full-document reads.
- Event, inbox, and history endpoints use bounded reads, reducing work on large records while preserving access to older content when requested.
- `npm run package:dev` creates a local development installer with a distinct application identity, data directory, and commit-stamped version. Development builds keep updates disabled and cannot replace the published installation. See [local development builds](dev-builds.md).
