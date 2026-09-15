# Orgtree 2.1.5-beta.7

Everything in 2.1.5-beta.6 is included. This build exists to fix the one thing
you rejected in beta.6: the order the `Staff…` menu asks its questions in.

**Install this by hand as well.** The channel work is done and correct, but a
build has to be *published* before an updater can find one, and this one is
handed to you as a file. Automatic updates begin working from the first
published build.

- **The account is now the last thing you choose.** beta.6 put the account
  directly under the model, so picking a tier asked which account before it
  asked which effort. You had not asked for that layer to sit there. The
  sequence is now model, then effort, then account: each effort row carries the
  eligible accounts beneath it, and clicking an account sends the tier, the
  effort and the account together as one request. Choosing an effort without
  opening the account list still means the account a plain hire would pick, the
  same as before.

  Where a tier has no effort to choose at all, the accounts stay directly under
  the model — moving the layer last should not delete it, and there is nothing
  to put it under.

- **Nothing else moved.** The two things you accepted in beta.6 are unchanged.
  The menu still does not load when it opens: the rows are drawn from the answer
  already held. The models are still in the model-switch order, grouped by
  provider and ordered by tier. The account layer still appears only where there
  is a real choice — a single eligible account the tier would take anyway is not
  a choice, and an OpenRouter lane has no account.

The change passed source review and is landed on main. It has not been exercised
in an installed build before this one.
