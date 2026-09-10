# Alpha.6 combined handoff

The September 9 corrective wave is merged, including the symmetric account implementation. The user requested direct implementation and merging by coordinator-astra and feature-fable, with their own review after integration.

## Delivered behavior

- Agents lists keep their ordinary inline opening, navigation and dismissal, with pin and popout controls.
- Desk headers retain one unnumbered Presented tab. Reply context, autofocus, attachment placement, badge sizing and resizing corrections are included.
- Pinned windows restore across restart; header window controls, provider themes and the orange overseer icon are included.
- Ticket double-click copying works through a narrowly scoped native clipboard permission. External web links open in the default browser.
- Provider usage panels show supported account identity and native sign-in controls. Claude and Codex account rows can sign into a selected profile and verify that same profile afterward. Antigravity uses the approved terminal entry and manual refresh.
- Accounts can be imported or created as managed profiles, assigned to agents, and removed only when unbound. Account choices disclose identity, authentication, billing and wait state. Account shades remain within the provider palette; work-status colors remain separate.
- Claude and Codex profiles read their own usage. Account usage expands on demand, avoiding remote requests for every collapsed row. Inferred limits remain visibly marked.
- Bound agents wait on the account's actual limit horizon without automatic account rollover. Cross-provider model changes and account reassignment share compatibility and availability validation.
- Startup descriptor ownership fixes and restoration of the boot task's previous Enabled state on stop failure are included.
- Graph annotation reuses the caller's loaded generation instead of repeatedly reloading the organization. Copied 396-node data measured warm server graph handling improving from 1263-1305 ms to 145-177 ms. See performance-2026-09-09.md for the measurements and their limits.
- Optional profiling has bounded, authenticated retrieval with numeric-only records and process identity. It remains off by default.

## September 10 continuation

- Account migration retries preserve minted IDs and saved bindings. Completion is recorded only after organization bindings and the migration report persist.
- The existing default Claude login keeps its original home-level metadata file; redirected profiles continue to use their own metadata. Import and sign-in use the same distinction.
- A read-only SQLite-copy rehearsal covered three current organizations and 540 agent bindings. All 23 missing profiles were Antigravity (21 archived agents and two live agents), consistent with the documented unsupported spawn lane. Repeating completed migration did not create accounts or change IDs. No live placement was changed.

## Delivery and remaining acceptance boundaries

The alpha.6 installer is prepared from the combined clean source. Source commits and package metadata identify the exact contents. It has not been installed, published, or used to restart the live system in this batch.

Existing live account placement is not migrated automatically. Migration runs only with ORGTREE_ACCOUNTS_CUTOVER=1 on the chosen backend startup and writes its report in the data root. Conditional or ambiguous legacy key placement remains held and documented; migrated org keys retain their original organization restriction.

Antigravity profile registration and validation are supported, but a redirected Antigravity spawn/usage selector has not been established. Such use is refused explicitly. Claude/Codex native profile selection and verification are tested with real fixture child processes; a person must still complete actual browser authentication before live account acceptance can be claimed.

Packaged-component acceptance uses isolated data, real packaged application code and Python, with an instrumented Electron driver. It does not execute NSIS, register the real boot task, or prove behavior after a real Windows boot. Native pointer injection is unavailable in this session, so the pinned-window dragging change still needs the user's actual pointer check.

The measured graph optimization is a server improvement, not a claim that the live 12-27 second load is fully attributed. Large-history parsing, live contention and full-graph rendering retain the limits stated in the performance report. Automated V1 import remains deferred by the user.
