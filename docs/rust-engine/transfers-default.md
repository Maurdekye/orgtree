# Transfers disclosure default

The user requested a collapsed Transfers section everywhere (2026-10-14
10:40Z). Every newly opened view starts collapsed. Expanding it stays local
to that open view, across transfer polls, until the user collapses or closes
it. No preference is persisted. Changing the mailbox org/agent resets it.

## Call sites

- `canvas/mail.tsx`: OrgInboxModal mounts TransferPanel for outside mail.
- `InboxView` mounts the same TransferPanel for user/agent mail, including
  desks and NodeInboxModal. Pinning or popping out retains the mounted view.
- Hubchat `components/Transfers.tsx`: both desktop placements of TransfersChip
  and Android TransfersStrip already initialize `open=false`; no product change.

Only the shared Orgtree initializer and scope-reset effect change. The existing
unfinished header count stays visible; completed-only lists have no count.
Transfer state/progress/actions, recent-history and paging behavior, HTTP poll
frequency and engine jobs are unchanged. Collapsing invokes no transfer action.

## Verification hand-in

Six renderer tests cover org/user/agent scope, polling while expanded,
completed-only headers, close/reopen, mailbox-scope changes and real org/desk
mail surfaces. The verifier builds an in-memory red control reverting only the
two changed lines and requires the same tests to fail on collapse assertions;
then green must pass. No historical whole files are replaced.

The real-component browser proof has 28 cases: Orgtree red/green, dark/light,
org/user/agent mail, active/completed; unchanged Hubchat desktop/Android in
both themes. It checks default rows, one-click expansion/collapse, updated
progress while expanded, a newly opened view collapsing, retained files and
zero browser errors. It mocks transport; no installed app or device is tested.

Run in rig-opus's existing lock/Job-contained batch, with all outputs in its
exact C scope and evidence on D. Portable commands (use combined repo paths):

    node tools/transfers-default-verify.mjs focused <orgtree-repo> <hubchat-repo> C:/orgtree-build/rig-opus/transfers-default
    node tools/transfers-default-verify.mjs browser-build <orgtree-repo> <hubchat-repo> C:/orgtree-build/rig-opus/transfers-default
    # TRANSFERS_OUT = the C output above
    # TRANSFERS_EVIDENCE = D:/orgtree-work/rig-opus-transfers-default-evidence
    python tools/transfers-default-proof.py

Read existing real dependencies in place, with optional TRANSFERS_ORGTREE_DEPS
and TRANSFERS_HUBCHAT_DEPS overrides. No dependency install, copy or junction.
Run root typechecks using the batch's normal Orgtree/Hubchat checks. Verification
is pending; syntax/whitespace checks alone do not claim test or visual passes.
