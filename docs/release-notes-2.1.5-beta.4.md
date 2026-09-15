# Orgtree 2.1.5-beta.4

Everything in 2.1.5-RC3 is included.

**This build has a new name, and the name is the point.** The previous candidates
were called `RC1`, `RC2` and `RC3`. The automatic updater reads the text after the
dash as the name of a release line, so an `RC3` build was sitting on a line whose
only member was itself: it would check for updates, find only itself, decide that
was not newer, and stop. Forever. This build is called `beta.4` because `beta` is a
line the updater knows how to leave — a `beta` build accepts later betas *and* the
stable release when it arrives.

**An installation of RC3 cannot find this build on its own.** RC3 is running the
old code on the old line, and nothing published can reach it. Install this one by
hand, once. After that, automatic updates work again.

The changes below have passed source review and are landed on main. They have
**not** been exercised in an installed build.

- Prereleases are on a release line the updater can leave. A beta installation
  receives later betas and the stable release; a stable installation ignores
  prereleases entirely, instead of being offered a candidate as soon as one is
  published. The release tooling now refuses an `-RC` version outright rather than
  producing another build that cannot update.
- Quick Hire on a backlogged ticket no longer leaves the ticket moved, the staffing
  request posted, and no agent hired. The wake reason is checked when the request is
  sent rather than minutes later on the recipient's turn, and a kickoff that is
  refused undoes the whole request — the ticket's prior status, its progress lists,
  the manual flag and the receipt — instead of leaving it stranded.
- The same class of failure is closed for the unstick path, which had been
  sending a wake reason nothing accepted.
- Google AI plan rows without authoritative metadata are omitted from the usage
  board rather than shown with a guessed tier.
