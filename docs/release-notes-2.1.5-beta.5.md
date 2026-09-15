# Orgtree 2.1.5-beta.5

Everything in 2.1.5-beta.4 is included. This build exists to fix the two things
you found while testing beta.4.

**This one your beta.4 installation can find on its own.** beta.4 sits on the
`beta` line, which the updater knows how to follow, so the tray's *Update now*
should offer it. The one manual install is behind you.

- **`Staff immediately` no longer offers you models it cannot staff, and no
  longer makes you wait when you open it.** Two separate faults. It judged
  availability against one account only, so a single full Claude account greyed
  out every Claude tier even while a second account still had room — it now asks
  per account and offers a tier when *any* account can run it. And it started
  loading the options when you clicked, running provider discovery and a live
  network call behind the menu; that work now happens when the app starts and is
  shared, so the menu is ready before you open it.

  Tiers and accounts that cannot be staffed are now left out rather than shown
  greyed. A greyed row is still an offer.

  The menu also gained the account step it never had — tier, then account, then
  effort. A tier stays one click when the account a plain hire would pick can run
  it. When it cannot, the tier is still offered and you choose the account: which
  account to spend is your decision, not the menu's.

- **The backend restart notice now names the installed version.** It reported the
  commit, which answers nothing about which release you are on. It now reads
  `Installed version: 2.1.5-beta.5` above the commit. Running from source says so
  plainly instead of quoting a number nobody installed, and unreadable build
  metadata says it is unavailable rather than guessing.

Both changes passed source review and are landed on main. Neither has been
exercised in an installed build before this one.
