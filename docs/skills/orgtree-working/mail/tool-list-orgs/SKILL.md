---
name: orgtree-tool-list-orgs
description: Discover active local organizations and cached hub peers with their explicit mail addresses and available transport labels.
---

Up: [orgtree-mail](../SKILL.md)

# orgtree_list_orgs

Use before choosing an outside mail address or resolving an ambiguous bare name. It returns public discovery metadata; it does not send mail, register identities, refresh a remote roster or grant permission to contact anyone.

Required tool group: `inspection`, inherited through the ancestor chain. Top-level and lower agents receive the same discovery form. Outside-send audience and inbox-policy checks still apply separately through [orgtree_message](../tool-message/SKILL.md).

## Parameters and call

The tool takes no parameters, filters, pagination or action.

```json
{}
```

## Results

The result contains a combined `orgs` array and the compatible `remote` array of cached peers:

- Local active organizations have `slug`, display `name`, explicit `address: "@org:<slug>"`, `you` for the caller's organization, and `transports`.
- Hub peers have full `@net:` slug/address, name, `online`, `last_seen`, `kind` (for example org/person), blurb, and hubs with address/name/version. Missing reported hub version is `unknown`.
- `transports` is `["org"]`, `["net"]`, or `["org","net"]` when that local network identity is also in the cached roster. Local and network identities can both appear in the combined data; shared labels do not imply one canonical permission or delivery route.

Hub addresses deduplicate across cached rosters and retain the hubs that know them. Local rows are active organizations sorted by slug. No identity secret/full net configuration is returned. There is no supplied count limit or cursor; do not invent either.

## Choose the route

Use the returned explicit address. Your own local row is discoverable but `@org:<your-slug>` is not a valid way to message yourself; name an agent. An online marker reflects cached roster presence and does not prove current delivery, a running agent, enabled inbox policy, or authority to act as the user.

Bare-name resolution first checks an internal agent, then an exact local-org slug, then a cached hub full slug/leading name segment. Ambiguity refuses rather than guessing; explicit prefixes choose the intended route. The message leaf owns the full routing and reach contract.

There are no tool-specific argument refusals because the exposed schema has no arguments. A denied inspection group prevents the call; discovered destinations may still be refused later by the send path. Do not treat an empty remote array as proof that an address does not exist anywhere: this is cached discovery, not a global directory search.
