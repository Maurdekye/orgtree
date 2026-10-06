# Orgtree 4 rewrite — the user's standing decisions

Every explicit decision the user (product owner) has made about the Rust rewrite, in the order
made. These bind the plan ([`PLAN.md`](PLAN.md)) and the code. A later entry that changes an earlier
one says so; nothing here is dropped without a new decision from the user. Add new decisions as
they are made, in the same landing as any change they cause.

All entries are dated 2026-10-06 unless stated otherwise.

## Mandate and working rules

1. **Rewrite the entire engine backend from the ground up in Rust**, using the existing bundled
   PostgreSQL. The frontend and its UX contract stay in place.
2. **Design from the frontend contract, not from the old backend.** Treat the renderer as the
   requirements document; pretend the Python engine does not exist; reuse none of its
   architectural patterns. Technical documents from the orgtree org's work docket may be borrowed.
3. **Prefer deprecating and omitting old or outdated features** wherever that makes the
   implementation more consistent, faster or more robust.
4. **Scale target: 1,000+ simultaneously active agents.** Multithreading, highly concurrent
   database access, channels between agents' tasks.
5. **No global locks of any kind.**
6. **Do all the work personally: no delegation** (no subagents).
7. **Work from the `dev` branch** (the rewrite branch is cut from `origin/dev`).
8. **After the plan is approved: no review agents and no unit tests during the build.** Churn out
   the rewrite as fast as possible; the user tests it personally; hardening with tests and review
   comes afterwards.
9. **Any conflict between a current user-facing feature and the new architecture goes to the
   user.** The user will usually accept reducing or altering features for performance or a
   simpler data model.
10. **The user must be told about every user-facing difference**, explicitly (kept in PLAN.md §10).
11. **Record every explicit decision as a standing note** (this file).

## Architecture

12. **Reduce overhead as much as possible.**
13. **Transport: HTTP for loading and actions; sockets for pushed updates.** (First "one socket per
    window" was chosen; the user then questioned using a socket for loading and HTTP was kept for
    loads. Supersedes the one-socket choice.)
14. **Socket rooms, like socket.io rooms / MQTT topic subscriptions**, so a window receives only
    what it shows — e.g. a room per agent for its live transcript.
15. **A full MQTT broker was considered** (user question); the recommendation against it (extra
    process and hop, no fit with the ordered record feed) stands unless the user decides otherwise.
16. **This ships as Orgtree 4 (4.0.0)**, because it removes notable functionality.

## Features that must stay (overriding the first draft of the ledger)

17. **The boot-time background engine task** (scheduled task, attach) is part of the MVP.
18. **Cache forecasting** (badge, countdown, changed parts, send warnings).
19. **The MCP waiting state**: MCP tools may come from external MCP servers that might not be
    present yet, so the tool-count / waiting state and "wait for MCP tools" stay.
20. **The org inbox** must be present (with `@org:` and `@net:` mail, holders, hub settings).
21. **The hiring credit cascade** (cascade hire / cascade allocate).
22. **Account fallback** remains an option.
23. **Mid-turn effort changes for Claude** must reach the running turn.
24. **Typed system-message cards** (ledger D1) stay.
25. **API-key accounts** (create them; metered spend) and the **ability to disable using
    subscriptions for inference** stay (ledger H3), with the API-key fallback switch.
26. **Agent tools kept:** `orgtree_staff`, `orgtree_swap`, `orgtree_self_subjugate`,
    `orgtree_unstick`, `orgtree_continue_on`, `orgtree_account_mark`, `orgtree_state_inspect`.
27. **Agent tools not needed:** `orgtree_preview`, `orgtree_capabilities` (reverses their keep in 26).

## Approval

28. **The plan is approved**: "all other decisions remain as planned" — every ledger entry in
    PLAN.md §10 not overridden above (no lineage nodes; no parked CLI per agent; Codex reserve
    routing, remote control, primed-restart chip and Fable policies removed; Antigravity mail at the
    next turn; one delivered state for steered rows; only `/compact` handled locally; old desk
    history from the CLIs' transcripts; cost diagnostics removed; crash recovery by a "continue"
    message; direct audience requests; the lean docket without acceptance checks, W08 evidence,
    review machinery, addenda or reservations; no Codex version-drift report; the agent-restart
    tools removed; and the data/startup changes A3–A6).

## UI and change management

29. **UI clean-up is allowed outside the canvas**, e.g. the settings menus. The canvas is not
    touched.
30. **Purely visual UI work goes on its own branch** (`rust-engine-ui`) so it can be rolled back
    cleanly. UI changes that follow from the featureset differences stay on the main rewrite
    branch (clarifies an earlier "keep frontend UI work separate").
31. **Settings for dropped features are omitted entirely** from the UI — not kept, not greyed out.

## Verification during the build

33. **Brief smoke tests are allowed**; beyond that the user judges for themselves how well the app
    works once it launches.

## Diagnostics

34. **Dense, verbose per-method invocation logging** (user 2026-10-06):
    - Every method defined in the engine is logged when it is invoked, with its full input and its
      full output, each capped at 8 KB (decision 36). The only exceptions are extremely hot calls (run thousands
      of times per request), such as per-token streaming, per-record feed rebuilding and tiny
      helpers.
    - Every line carries a request id prefix, a client id prefix (`user`, `desktop`,
      `agent:<id>/<name>` or `engine`) and a method invocation id prefix: one id per stack frame,
      shared between that method's call line and its return line.
    - Log lines have sub-millisecond timestamps.
    - Each engine start writes its own log file, named with the start time.
    - Log files are kept for 30 days.
    - The style is borrowed from the galaxy-star backend (nick-pc): `LEVEL [time] RQ… EX… message`
      lines, `module.fn(args)` call lines and `module.fn(...) -> value` return lines (`!!` for an
      error), REQUEST/HEADERS/RESPONSE lines per HTTP request, `*****` for sensitive fields,
      multiline messages split into prefixed lines, and daily/size rollover to gzip archives.
    - A line over the cap is brought under it like this. First, values (arguments, or the members
      of a return value) are shortened largest-first to their first 160 characters (arguments)
      or 240 characters (return values; decision 36) followed by
      `[rest omitted: x.y kb]`, until the line fits. If every value is shortened and the line is
      still too long, values are replaced largest-first by `[omitted: x.y kb]` alone. The line is
      truncated only as a last resort.
35. **Verbose logging can be turned off, as galaxy-star's `LOG_VERBOSE` does, and is off by
    default** (user 2026-10-06):
    - Verbose logging is the per-method call and return lines of decision 34, each request's HEADERS
      line, and the settings written at startup. REQUEST and RESPONSE lines, warnings and errors
      are written either way.
    - Off by default in packaged builds; on by default in every local development build.
    - Implementation: a runtime switch (App settings › Developer › "verbose engine logging"),
      applied at once, rather than a compile-time flag; with it off, a logged method costs one
      atomic load. Packaged builds are compiled with `ORGTREE_RELEASE_BUILD` set, and
      `ORGTREE_LOG_VERBOSE=0|1` fixes the switch for one run.
36. **Log line limits** (user 2026-10-06; replaces decision 34's 5 KB cap and 100-character
    preview): a line is capped at 8 KB; a shortened argument keeps its first 160 characters and
    a shortened return value its first 240; the console mirror cuts lines at 500 characters (the
    file keeps them whole).

## Release

37. **The first complete prototype of Orgtree 4 is delivered as a local installer in the user's Downloads
    folder** (user 2026-10-06): built locally from `rust-engine` as version 4.0.0; no tag, release, push or
    install by the agent.
38. **Prototype builds are versioned `4.0.0-alpha.N`** (user 2026-10-06): the alpha number counts
    delivered builds. The first delivered build, labelled 4.0.0, is alpha.0; the next is
    `4.0.0-alpha.1`. Installers go to the user's Downloads folder, `E:\Libraries\Downloads`.
39. **The orgtree org may help with 4.0.0** (user 2026-10-06; amends decision 6), "but only if it isn't
    unstable from having to restart the org often during prototype builds". Every prototype install
    restarts Orgtree, which interrupts running turns and kills every process agents started; so the
    org takes only work that survives that (small committed steps, no long-running jobs), stops any
    task that restarts keep breaking, and hands changes in as branches off `rust-engine` that the
    rust-engine session reviews and merges. No subagents are added (decision 6 otherwise stands).
32. **Migration from 2.x is not needed for the first build, but must ship before the release is
    published.**
