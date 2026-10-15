---
name: orgtree-phone-link
description: "Explain the phone-link panel, setup codes, stored keep-awake preference and link lifecycle."
---

Up: [orgtree-mailhub](../SKILL.md)

# Connect your phone

Open **Connect your phone** from an org's Connections tab, the first-use/Home card, App settings > Mail hub, or the tray action. The panel uses the selected org; from Home/tray it resolves a candidate org. Confirm the org named in the panel before linking. Dismissing the introductory card hides both Home and org versions; App settings keeps the entry available.

The panel separates **This PC** from **Your phone** and shows one QR code at a time. Its state distinguishes missing/signed-out/ready Tailscale, phone access off/restricted/unrestricted, setup waiting, and a linked identity. Loading or hub errors are actionable states, not proof the setup completed.

## Setup path

1. On the PC install and sign in to Tailscale, or choose **Use my home Wi-Fi instead**. The Tailscale route uses the same account on the phone; the Wi-Fi route requires the same local network.
2. Choose **Turn on phone access**. The native Windows bridge requests permission for the scoped firewall rule before enabling the relay-only door. Tailscale scope limits access to the tailnet; home-network scope permits reachable local clients to register and message, without exposing the operator's full mail page. Already unrestricted access offers **Limit it to Tailscale** when Tailscale is ready.
3. On Android, install/sign in to Tailscale where using that route, then scan the download QR to get Hubchat. Choose **I have Hubchat on my phone → Next** on the PC to replace the download QR with the setup QR after the PC is ready.
4. In Hubchat choose **Scan setup code**. A setup code is single-use and normally lasts ten minutes. **New code** replaces earlier codes; an expired/used code needs a new one. The panel shows Waiting while the setup is being handled.

The setup needs the org connected to the computer's hub. When code creation reports that local membership is missing, the panel attempts to turn it on. A person already in the local roster can instead be offered **Is this you?**; confirm only your actual identity. A desktop Hubchat user is guided to carry that identity to the phone rather than create another one accidentally.

## Link, more devices and Unlink

The PC keeps one phone-link record at a time in `<data>/phone.json`. Linking writes a marked note at the top of the selected org's `org.md`, naming the exact `@net:` address. The authority meaning belongs to `orgtree-external-mail` (orgtree-working › mail). That org's agents are reconfigured before their next turn; this does not rewrite instructions already in flight.

To add another device for the same identity, use Hubchat's **Settings > Devices > Link a device** on the existing device and the matching existing-identity flow on the new one. A new phone link requires **Unlink** first.

**Undo** after a new link and **Unlink** remove the generated authority notes from org charters and clear the saved link. If a note cannot be removed, the error is reported and the link record is kept. Do not describe Unlink as disabling the relay, deleting Hubchat's identity, deleting mail, or disconnecting all devices; these are separate operations. A malformed marked note can require human repair in the charter.

## Availability and keep-awake limits

**Keep this PC awake while it’s plugged in** stores `keep_awake` in `phone.json`, default true. The checked source persists and displays the preference, but no sleep-inhibition consumer was found. Its actual power-management effect is unverified; do not promise the PC will stay awake because it is checked. Use actual machine power settings and reachability when diagnosing sleep-related loss of access.

The panel can warn about a sleep timeout, Tailscale key expiry, or Tailscale stopping on Windows sign-out, with appropriate help links. The Android instructions recommend Always-on VPN and unrestricted battery use for Tailscale. Network access still depends on the PC/hub and the chosen network remaining available.

## See also

- See `orgtree-external-mail` (orgtree-working › mail).
- [orgtree-hubchat](../hubchat/SKILL.md)
