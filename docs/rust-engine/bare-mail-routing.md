# Bare-name external mail routing

F03 restores the 3.x resolver (`ledger._resolve_recipient`,
`api._external_candidates`) and `api._list_orgs_payload` contract.

An existing internal agent wins, including archived agents; lack of permission
to reach that agent never falls through to an external namesake. If no internal
agent matches an unprefixed name, an exact local organization slug wins. Otherwise
the cached hub roster is matched by full network slug or its first dot-separated
segment. One distinct match resolves to `@net:<slug>`; multiple matches refuse
and list the full addresses in deterministic order. Unknown names retain the
existing not-found response. Explicit prefixes retain their existing behavior.

Resolved mail passes through the existing `orginbox::send_extern` authorization,
attachment and delivery paths. Network attachment staging resolves the same name
before choosing the transport's file policy. There are no new network requests
in discovery or bare-name matching, and no new write authority.

`orgtree_list_orgs` includes local organizations, including the current one with
`you: true`, and the deduplicated hub peers in the combined `orgs` array, as 3.x
did. Each row has `transports: ["org"]`, `["net"]`, or both when a local network
identity is also in the roster. Peer presence fields are retained. The 4.0
`address` field and `remote` array remain for compatibility. Local discovery reads
only slug, display name and the network identity's public slug, never its secret.

Verification uses an isolated executable containing the actual production pure
resolver/discovery functions and synthetic local/roster rows. It does not send
mail to a real org or hub. Existing authorization and delivery integration is
source-checked; cargo check validates the full Rust composition.
