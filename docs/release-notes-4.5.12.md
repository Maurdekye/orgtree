# Orgtree 4.5.12

Orgtree 4.5.12 lets Orgtree apps act as read-only viewers of a headless org, adds a usage watchdog that fires relative to the Fable pip, marks the part of the Fable bar that can no longer be reached, and gets new mail from the mail hub over a live connection where the hub offers one. It still bundles Mail hub 2.4.0 and works with Hubchat 1.3.5.

## Apps

- **Private-network sites.** An app can declare a site on a private network (for example a Tailscale `100.x` address or a LAN address). Its Permissions row offers **Allow private network**, with a confirmation. The allowed address is pinned, and if the name later resolves elsewhere the row asks you to re-pin it. Private sites may use plain `http`, and redirects stay on the same site.
- **Saved logins.** An app can ask to save a login (such as a token) for one of its sites. The engine stores it sealed for that app and site and attaches it to that site's requests itself; the app never reads it back, only whether a login is attached.
- **Live channel.** Apps can hold a live connection to an allowed site through the engine (`orgtree.net.connect`). The status bar shows a chip per open channel, and Permission history records it. Revoking the site closes the channel.
- **Viewer tokens for the standalone engine.** A client token can be created as a **viewer** for one org. It can read that org's state, mark the user's mail read and mark presentations viewed, and nothing else; its org socket only listens. This lets an app show a remote headless org without holding an operator token.

## Usage

- **Fable pip watchdog.** A usage watchdog can fire relative to the Fable pip instead of a fixed percentage: for example "2 points before the pip" or "1 point past it". It fires when the weekly reading crosses that point and again when it clears it, and works only on Claude accounts with a Fable weekly window.
- **Unreachable end of the Fable bar.** Once weekly usage is past the pip, the part of the Fable bar Fable can no longer reach this week is shown in red, and its hover text says how far Fable can still go.

## Mail hub

- **Live new-mail connection.** Orgtree asks a mail hub for new mail over one WebSocket stream when the hub offers it, and over the usual long poll otherwise. If the stream drops or isn't offered, Orgtree falls back to the long poll by itself and tries the stream again later. Delivery is unchanged: mail stays queued on the hub until Orgtree acknowledges it. Mail hub 2.4.0, bundled here, uses the long poll.

## Fixes

- Settings rows for private sites and saved logins keep their details and buttons inside the dialog, and dialog buttons (Cancel/Allow, Cancel/Save) sit side by side.
- Separators in the private-site badge and the channel history row no longer show as garbled characters.
- The engine retries briefly when saving its client registry hits a sharing or lock error, instead of failing with "could not persist client registry".
- The standalone engine image's build context includes the language-server test fixture.

## Untested

- The final release build wasn't run hands-on before publishing; the user installed and ran 4.5.12-alpha.1, which has the same code apart from the version number and documentation.
- The upgrade's two database changes were checked at engine level on a 4.5.11 test database, not by upgrading an installed app.
- The app panel's private-site screens were checked by automated tests and screenshots of the settings rows, not by a screenshot of the running panel.

## Notes

- Two database changes since 4.5.11 (private sites and saved logins). They apply automatically on first start.
- The standalone (headless) engine ships again in three forms: the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.5.12`, plus the agents image `:4.5.12-agents`. These packages are optional: the desktop app doesn't need them.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
