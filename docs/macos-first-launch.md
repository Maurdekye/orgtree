# macOS first-launch flow

The macOS build produced by `npm run package:mac:dir` / `npm run package:mac`
is ad-hoc signed (`identity: "-"`, no Apple Developer account, no
notarization; see PROJECT.md's locked v1 scope). Ad-hoc signing satisfies
Apple Silicon's AMFI load-time signature check but carries no verified
identity, so macOS treats the app differently depending on where it is
launched from. This document distinguishes the two flows and states what
to expect from each. It does not cover notarization, real code-signing
certificates, or the Windows installer flow (see docs/windows-release.md
for that).

## Flow 1: launching in place, on the machine that built it

When the `.app` produced by `npm run package:mac:dir` is launched directly
from `release/mac-arm64/Orgtree.app` on the same Mac that built it, no
`com.apple.quarantine` extended attribute is present. AMFI still checks
every Mach-O's ad-hoc signature at load time regardless of quarantine, so
a correctly signed build (package.json's `build.mac` config plus
`tools/sign-runtime-macos.mjs`, both from this phase) launches with no
dialog and no user action.

If this flow ever requires a right-click-to-Open approval, or macOS
reports the app is damaged and cannot be opened, that is a signing
regression, not expected behavior. Check that:

- `codesign -dv --verbose=4 release/mac-arm64/Orgtree.app` exits 0.
- `codesign -dv --verbose=4 release/mac-arm64/Orgtree.app/Contents/Resources/engine/runtime/bin/python3.13`
  exits 0 (confirms `tools/sign-runtime-macos.mjs` ran as an `afterPack`
  hook and signed the bundled runtime, which electron-builder's own
  signing pass never reaches).

## Flow 2: an `.app` that traveled to another Mac

A `.app` copied via AirDrop, downloaded as a zip, or carried over on a USB
drive picks up the `com.apple.quarantine` extended attribute from
whichever macOS service handled the transfer. Gatekeeper checks quarantined
apps before AMFI ever gets a chance to run, and an ad-hoc-signed app (no
verified developer identity) fails that check. The first double-click shows
a dialog such as "Orgtree cannot be opened because the developer cannot be
verified" (wording varies by macOS version).

Recovery:

1. Right-click (or Control-click) `Orgtree.app` in Finder and choose
   **Open**. Confirm in the follow-up dialog.
2. If Finder does not offer that option, open **System Settings > Privacy
   & Security**, scroll to the blocked-app notice near the bottom, and
   choose **Open Anyway**.

Either path only has to be done once per copy of the app; macOS remembers
the approval for that specific `.app` bundle.

## Reproducing Flow 2 without an actual transfer

To test the quarantine/Gatekeeper path without AirDropping or downloading
the build, apply the extended attribute by hand to a copy of the built
`.app`:

```sh
xattr -w com.apple.quarantine "0081;$(date +%s);Safari;" release/mac-arm64/Orgtree.app
```

Double-clicking the app afterward should reproduce Gatekeeper's blocked-app
dialog, and the right-click-to-Open (or System Settings) recovery above
should clear it. Do not apply this to the copy you intend to keep using for
Flow 1 testing; use a separate copy or `xattr -d com.apple.quarantine` to
remove the attribute afterward.
