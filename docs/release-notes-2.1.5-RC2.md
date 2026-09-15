# Orgtree 2.1.5-RC2

Everything in 2.1.5-RC1 is included.

This candidate has passed source review and headless checks. Upgrading an older installation through both the in-app and the manual route remains to be verified on the authorized test PC before public promotion.

It adds the following.

- The Windows post-upgrade relaunch now uses the GUI Python host that Orgtree already ships, instead of PowerShell.
- Silent all-users updates request elevation before the installer's preflight, and they resolve the executable the close helper needs.
- The installer reports the elevated child's own result rather than merely reporting that it started, so an update that was declined or that failed is no longer recorded as a success.
- The helper that restarts Orgtree after an update waits on a real process handle, taken from a host that machine policy cannot switch off, and it takes that handle before it promises Setup that it will wait. If it cannot, Setup keeps the launch itself instead of handing it to something that is not there.
- Orgtree is relaunched exactly once after an update. The installer and the helper settle who performs the launch with a single claim that cannot be created twice, and every update carries its own identity, so a reused process id can never block a later update.
- The Finish page of the installer has a working launch control again.
- An update that was prepared and then failed can be recovered by hand from the app, and ordinary update checks resume afterwards instead of stopping.
- The Windows installer declares its log variables before the code that assigns them, so its log is complete from the first line.
- Gemini and Antigravity accounts report the authoritative tier: it is resolved from probe logs as well as structured status, and the capability cache is keyed by CLI version so an upgrade invalidates a stale reading.
- Request staffing is steadier: discovery runs outside the document lock, and staffing offers are separated from direct-hire eligibility.
- Agent names shown on far-zoom hover are counter-scaled so they stay readable at any zoom level.
