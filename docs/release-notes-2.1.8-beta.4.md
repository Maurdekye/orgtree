# Orgtree 2.1.8-beta.4

One fix, on top of beta.3.

## Upgrading an existing installation

This is a prerelease. A stable installation ignores prereleases, so the tray's
**Update now** will not offer it — install this build by hand once. From then on
the installation sits on the `beta` line and receives later betas and the
eventual stable release automatically.

## The attach button works again in mail replies

The file-attachment button in the mail reply box was dead — visible, but greyed
out, so a reply could not carry a file. The reply box enables attaching only
when it knows which organization the mail belongs to, and the one place in the
app that renders a mail reply was not passing that along. It now resolves the
organization the same way the rest of that screen already does.

This was **not** new in beta.3. The same gate has been in place for several
builds; what changed in beta.3 was that the control became a paperclip you could
see was disabled, where before it was easier to miss. The ticket reply and
presentation reply boxes were checked for the same problem and do not have it.
