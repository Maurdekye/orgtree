---
name: orgtree-mailhub-hosting
description: "Explain this installation\u0027s mail hub hosting controls, defaults and save effects."
---

Up: [orgtree-mailhub](../SKILL.md)

# App settings > Mail hub > Hosting

Hosting belongs to the installation: one computer hosts at most one bundled hub. Organizations choose their outbound hub connections separately in [Org settings > Connections](../org-connections/SKILL.md). Hosting settings are stored in `<data>/mailhub-hosting.json` through `/api/desktop/hub`; they are not per-org settings.

## Fields and defaults

| Control | Meaning and default |
| --- | --- |
| Hub name | Display name shown to connected clients and on the hub's operator page. Stored default is empty; the input's computer-name text is a placeholder. Save trims it and refuses newline/NUL characters. |
| Maximum attachment size (MiB) | Default 1024 MiB, exactly 1 GiB. UI accepts positive whole MiB and stores bytes as `max_attachment_bytes`. The engine requires a positive safe integer number of bytes. |
| Port | Main hub port, default 7370; integer 1–65535. |
| Listen on | Default **This computer only** (`127.0.0.1`); **This computer and the local network** uses `0.0.0.0`. This is the main operator interface, distinct from the relay-only door. |
| Keep mail | Default **Until it is deleted** (`retention_days: null`). A limited number of days enables **Days to keep mail**, 1–36500. The form starts that choice at 30 days when no saved duration exists. |
| Also serve a relay-only door | Default off (`public_listener: false`), normally port 7371. Carries authenticated client traffic without the full operator mail page. Phone setup can restrict its scope to Tailscale or the home network. |

The limited-retention UI warns that old mail and attachments are deleted hourly, read or not. Keeping indefinitely means until the owners delete it; it is not a backup policy. A stored `org_retention_days` compatibility value is not an active idle-address expiry control: the current host launch does not pass it to the hub.

## Network exposure

The main operator page has no login and can show all mail the hub carries. Exposing `0.0.0.0` makes that interface reachable wherever the network/firewall allows it. The hub does not itself provide TLS; use an appropriate private network or TLS proxy for the deployment. For other clients, share the relay-only address rather than the main operator port. The relay setting's word “public” does not require an Internet-facing deployment.

The relay's phone scope is managed by [phone setup](../phone-link/SKILL.md). The hosting form displays that scope but does not edit it. Its stored default scope is `all`; do not describe manually enabling the relay as automatically restricting it to Tailscale.

## Save, status and errors

Form edits wait for **Save hosting settings**. A maximum-upload-limit-only save writes the runtime limit file and applies to new uploads without restarting the hub. Other hosting changes stop and start the hub; a start error normally restores the previous configuration and attempts the previous hub again. This is a hub restart, not an engine restart. Treat any error or stopped/starting status as unresolved, even if an earlier save succeeded.

Turning off a previously enabled relay also asks the desktop to remove its phone firewall rule, with an administrator prompt where needed. If removal is declined the rule can remain, while the door is off. **Refresh hub status** reloads saved configuration and status, so it can replace an unsaved form draft.

Status distinguishes running/healthy, starting and stopped, and shows address, hub version, registered clients and queued count where available. Startup errors and migration/import notes appear separately. The operator-page link appears when healthy. A displayed version or queue count is not proof a particular recipient read a message.

## See also

- [orgtree-org-connections](../org-connections/SKILL.md)
- See `orgtree-tool-transfers` (orgtree-working › mail).
