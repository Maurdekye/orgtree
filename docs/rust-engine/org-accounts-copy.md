# Short Accounts explanation

User 2026-10-14 18:46UTC, ticket
`org-settings-accounts-shorten-the-explanation-bl` requested deletion or a few
dozen words. The paragraph keeps its `.dim.hub-hint` placement/style and says:

> This org's agents use only ticked accounts. Unticking takes effect after any
> running turn: agents move to another ticked account of the same provider when
> possible, or stop. New accounts start ticked.

The adjustment from the coordinator's proposed text is “when possible”, since
mere ticked status is not proof of a usable replacement and language-server
seats do not migrate to a different server. No runtime behavior changes.

Source verification on `0f8638f`: `org_accounts.rs::allowed` stores only
disabled IDs (a new ID is allowed), `barred` checks the seat's canonical lane,
and `leave` tries same-provider continuation candidates then freezes with a
reason. `leave` excludes language servers from replacement selection.
`runtime/actor.rs` admission invokes this before claiming mail (around3439).
HTTP settings updates the list and rechecks frozen seats (around382), without
interrupting running turns. These support each remaining statement.

Existing disabled-account row hints remain in `orgaccounts.tsx` (App settings
› Providers, enabling there first). A search of renderer tests found no assertion
of the old paragraph, so no test fixture needed changing. Rig-opus's next batch
should run the existing `orgaccounts` suite and root typecheck. Static word-count
and whitespace checks are source evidence; renderer execution is pending.
