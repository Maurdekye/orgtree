# Orgtree 2.1.5

This release makes self-updating trustworthy, adds staffing straight from the
docket, and corrects what the interface claims about accounts and plans.

## Upgrading an existing installation

If you are running 2.1.4, the tray's **Update now** will find this release and
install it.

## Self-updating

- An update waits until the installer is actually observed running before
  Orgtree exits. A process id coming back is no longer treated as proof, so an
  installer that is declined at the permission prompt, or that dies immediately,
  no longer leaves the application shut down having installed nothing.
- When an update cannot be handed off, Orgtree says so from a process that is
  still alive to say it. It records the outcome, relaunches, and the relaunched
  instance shows the failure, naming the reason and where the log is. An update
  that was prepared and then failed can be recovered by hand, and ordinary
  update checks resume afterwards instead of stopping.
- Orgtree is relaunched exactly once after an update. The installer and the
  restart helper settle who performs the launch with a single claim that cannot
  be created twice, and every update carries its own identity, so a reused
  process id can never block a later update.
- The restart helper waits on a real process handle taken from a host that
  machine policy cannot switch off, and it takes that handle before it promises
  Setup it will wait. If it cannot, Setup keeps the launch itself rather than
  handing it to something that is not there.
- The post-upgrade relaunch uses the GUI Python host Orgtree already ships
  instead of PowerShell, so no console window appears.
- Silent all-users updates request elevation before the installer's preflight,
  and the installer reports the elevated child's own result rather than merely
  that it started — an update that was declined or that failed is no longer
  recorded as a success.
- Closing a console window no longer kills Orgtree cold. Console-close,
  interrupt and break signals shut the application down in order, and closing
  the originating console, the parent shell or the engine cannot cancel an
  update that has already been accepted.
- Update progress is written to durable phase markers, so an update that ends
  badly can be diagnosed afterwards instead of leaving only silence.
- The Windows installer writes its own log from its first line onward —
  including the command line it received and whether it had administrator
  rights — and declares its log variables before the code that assigns them, so
  a failure before any page is shown still leaves a complete record. The Finish
  page has a working launch control again.
- Prereleases now sit on a release line the updater can leave. A `beta`
  installation receives later betas *and* the stable release; a stable
  installation ignores prereleases entirely instead of being offered a candidate
  as soon as one is published.

## Staffing from the docket

- A team docket is available behind the agent context menu, and staffing an item
  is recorded as its own readable docket update.
- `Staff…` creates the seat and assigns the work in one action, with the same
  progress preservation as an ordinary staffing, and its submenus dismiss in the
  window the right-click came from.
- The menu asks in one order: **model, then effort, then account.** Each effort
  row carries the accounts that can run that tier beneath it, and choosing one
  sends the tier, the effort and the account together. An effort taken without
  opening the account list means the account a plain hire would pick. The
  account layer appears only where there is a real choice — a single eligible
  account the tier would take anyway is not one.
- The menu offers only what can actually be staffed. Availability is judged per
  account rather than against one account only, so a single exhausted Claude
  account no longer greys out every Claude tier while a second account still has
  room; tiers and accounts that cannot be staffed are left out rather than shown
  greyed, because a greyed row is still an offer.
- The menu is ready before it opens. Provider discovery and its network call
  happen at startup and are shared, a docket row prepares its options when it is
  drawn, and building the trial organization no longer copies chat history, mail
  and event logs that a hire never reads — on a large organization that alone
  was about a second per tier.
- Models are listed in the same order as the model-switch dropdown: grouped by
  provider, ordered by tier. A tier the provider document does not list keeps
  your organization's own order and goes last.
- Quick Hire on a backlogged ticket no longer leaves the ticket moved, the
  request posted, and no agent hired. The wake reason is checked when the
  request is sent rather than minutes later on the recipient's turn, and a
  refused kickoff undoes the whole request — the ticket's prior status, its
  progress lists, the manual flag and the receipt. The same class of failure is
  closed for the unstick path.
- Request staffing runs its discovery outside the document lock, and staffing
  offers are separated from direct-hire eligibility.

## Accounts, plans and usage

- Google AI accounts are labelled with the official paid tier names, resolved
  without the old authentication-method fallback. Gemini and Antigravity
  accounts report the authoritative tier, resolved from probe logs as well as
  structured status, with the capability cache keyed by CLI version so an
  upgrade invalidates a stale reading. A plan row without authoritative metadata
  is omitted from the usage board rather than shown with a guessed tier.
- A pinned desk shows its account ID once, in its token list, and Codex cards
  keep their serving account across the turn.
- A frozen agent can be continued on another account from its menu.

## Mail and file delivery

- Direct file delivery no longer refuses an authenticated agent whose
  conversation has resumed. A live seat could be rejected with "caller has no
  durable seat identity" after resumption even while every other operation
  recognised the same agent; the authenticated actor-to-seat handoff now
  preserves an established seat, and a delivery that fails for a transient
  reason can be retried rather than being final.
- Delivered files are hashed on Python 3.10 as well as newer interpreters, and a
  corrupted delivery receipt is refused with an error that says what is wrong.
- A retired import binding can no longer silence a mailbox, long managed tool
  calls yield at safe delivery boundaries, and unpublishable tool results are
  retired without consuming active capacity.

## Interface

- The backend restart notice names the installed version above the commit.
  Running from a source checkout says so plainly instead of quoting a release
  nobody installed, and unreadable build metadata says it is unavailable rather
  than guessing.
- Agent names appear on far-zoom hover, counter-scaled so they stay readable at
  any zoom level, and a zoom-in cursor marks zoomable cards.
- Context menus open in the window the right-click came from, and presenting a
  document focuses the popped-out window that is already open instead of opening
  another.
- Questions with no options are presented as free response, bulk subordinate
  retirement is available as a context action, and the canvas halt outline is
  limited to the organization killswitch.

## Testing

Tests that disturb the desktop — ones that open consoles, show dialogs, or run
the real installer toolchain — sit behind two barriers. An ordinary `npm test`
cannot reach them, and each refuses to run without an explicit opt-in, so
running the suite can no longer take over the machine.
