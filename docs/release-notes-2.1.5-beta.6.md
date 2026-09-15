# Orgtree 2.1.5-beta.6

Everything in 2.1.5-beta.5 is included. This build exists to fix the two things
still wrong with the `Staff…` menu when you tested beta.5.

**Install this by hand as well.** The channel work is done and correct, but a
build has to be *published* before an updater can find one, and this one is
handed to you as a file. Automatic updates begin working from the first
published build.

- **The menu no longer loads when you open it.** beta.5 fixed a preload path,
  but not the one your right-click actually used, so it still stalled. The cause
  turned out not to be the network at all: building the trial organization used
  to copy the entire stored document, including chat history, mail and event
  logs that a hire never reads. On your own organization — 576 agents, an 80 MB
  store — that was about a second per copy, once per tier, so opening the menu
  spent around ten seconds copying logs. It now copies only the sections a hire
  needs, every verdict unchanged, and the whole set of tiers costs well under a
  second. On top of that, a docket row prepares its staffing options when it is
  drawn rather than when you hover, and the right-click reads what is already
  held. The "loading" placeholder still exists, but only for the case it
  describes: nothing prepared yet.

- **The models are in the right order.** The order now comes from the same
  provider document the model-switch dropdown renders from — Claude, Codex,
  Antigravity, then the OpenRouter favorites — so there is no second list that
  can drift away from the one you already know. A tier the document does not
  list keeps your organization's own order and goes last.

Both changes passed source review and are landed on main. Neither has been
exercised in an installed build before this one.
