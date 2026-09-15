# Orgtree 2.1.5-RC3

Everything in 2.1.5-RC2 is included.

The changes below have passed independent source review and are landed on main.
They have **not** been exercised in an installed build: direct file delivery after
a session resumes, and the corrected Google AI plan names, still need to be
confirmed on an installed Orgtree. Upgrading an older installation through both
the in-app and the manual route also remains to be verified on the authorized
test PC before public promotion.

- Direct file delivery no longer refuses an authenticated agent whose conversation
  has resumed. A live seat could be rejected with "caller has no durable seat
  identity" after resumption even while every other operation recognised the same
  agent; the authenticated actor-to-seat handoff now preserves an established seat
  instead of discarding it, and a delivery that fails for a transient reason can be
  retried rather than being final.
- Delivered files are hashed on Python 3.10 as well as newer interpreters.
- A corrupted file-delivery receipt is refused with an error that says what is
  wrong, instead of failing in a way that gives the caller nothing to act on.
- Google AI accounts are labelled with the official paid tier names, and the
  account tier is resolved without the old authentication-method fallback.
