# Argon effort

Argon previously offered only low and high because `antigravity_effort` mapped
medium to high. `providers::effort_names` filters its offers through that mapper,
so the same restriction both hid the picker option and changed launch behavior.
The mapper now retains medium for Argon, leaving all other tier mappings and
the account's conditional-model availability gate unchanged.

## Offline CLI evidence

On 2026-10-16, the installed Windows CLI (193,870,488 bytes, SHA256
`4790560754318d0ced2358d13cbce9181dfc51d1964c3d95c9776e8eaf5cd3c4`)
advertised medium in `--help`. Static inspection additionally found the explicit
`gemini-4-argon-medium` identifier and `Gemini 4 Argon (Medium)` label.
The identifier at file offset `0x370f8fa` is referenced by the code-assist
model map initializer, not only present as debug text.

The CLI's `backend.slugFor`/`parseModelSlug` parse model effort suffixes;
`effortIndex` indexes registry rows by base and effort, and `ResolveEffort`
selects that entry. Argon has no special legacy alias overriding this parsing.
This supports medium when the account registry offers that entry. No account
probe, online registry fetch or model invocation was performed. Static support
does not establish a particular account's current server-side availability.

## Delivery and timing

`runtime/actor.rs::ensure_agy` passes the mapped value in `AgySpec`; the driver
adds `--effort <value>` to the command. Gemini's pinned base model remains
`gemini-4-argon`. A saved effort change invalidates process reuse and applies
at the next turn, resuming the conversation. There is no AGY mid-turn effort
control. The setting is functional; its effect on reasoning tokens, latency
or answer quality is not measured by an offline or fake-CLI test.

## Verification

Tests-first commit `87fded5` on base `b3791bb` was independently executed by
rig-sol-b: two tests ran and both failed semantically (exit 101), without
compiler warnings. The launch mapper returned high instead of medium, and
the offer list returned low/high instead of low/medium/high.

The tests also retain controls for other tiers and inherited-level clamps.
`tools/rig/proofs/agy-argon-effort.mjs` exercises synthetic registry discovery,
saved high-to-medium selection, actual fake-CLI launch arguments, next-turn
process replacement/resume and turn completion. Final green verification is
pending; this proof establishes Orgtree delivery only, not real model behavior.
