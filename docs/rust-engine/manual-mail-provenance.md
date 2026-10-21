# Manual transcript mail: dispatcher provenance and current authorization

Explicit inbox fetch/chunk and ready fair-queue results project actual received
mail after the containing tool. A foreign MCP tool with the same basename must
never turn a supplied mail UID into an authorized canonical mail read.

The hardening regression reproduced the old failure in an isolated PostgreSQL
fixture: a foreign result naming a known restricted-project UID caused a real
user transcript row to be appended. The separate canonical read returned hidden
outside mail and an unrelated project's mail. No live data or guessed IDs were
used; native provider execution remains outside this synthetic proof.

Only the engine's successful dispatcher creates private `_manual_mail_reads`
receipts. Native tool IDs bind them directly. When a harness omits that ID,
`record_tool_card` retains the receipts with dispatcher-owned call metadata.
A successful completion can correlate these only with the original reserved
Orgtree MCP server identity, matching arguments and the actual dispatcher result.
Returned JSON cannot create a receipt, even if it claims Orgtree's name.

AGY eager names and native `call_mcp_tool` wrappers are checked before display
normalization. Foreign wrappers, bare unproven names and conflicting server
aliases fail closed. Display normalization remains an annotation convenience,
never an authorization boundary. Matching identical dispatcher proofs are
interchangeable; contradictory proofs are omitted. Receipt metadata stays
private and never appears in a public tool chip.

Before selecting any canonical body, the transcript reader rechecks that every
non-self recipient is a nondeleted project in the same organization and the
caller currently reaches it. It shares the protected project-inbox visibility
predicate, including the outside-inbox setting, and requires project inbox
recipient kind. UID/recipient pairs and existing transcript receipts still bind
the exact read and prevent duplicates across chunks/reloads. Queue custody is
unchanged: projecting a project read never claims or acknowledges it.

The fix adds no tool or UI action. Existing inbox fields and dispatcher routes
remain the authorized interface. Focused tests cover foreign names/wrappers,
missing/real dispatcher proofs, native-ID and ID-less compatibility, reach
revocation, outside visibility, organization/recipient boundaries, transcript
placement and once-only projection.
