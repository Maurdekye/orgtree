---
name: orgtree-app-remote-access
description: "Explain remote access: letting other computers open an organization of this desktop, adding a computer, where it listens and the firewall rules."
---

Up: [orgtree-app-settings](../SKILL.md)

# Remote access

Remote access lets another computer that runs Orgtree open an organization of this desktop and work in it as the user does. It is off until the user turns it on for one organization, and it is the user's alone: no agent tool turns it on, adds a computer or makes a code. Agents explain these controls; the user operates them. It exists on a desktop's own engine only. A standalone (headless) engine has client tokens instead, and an organization that itself runs on a remote engine cannot be passed on, so neither shows these controls.

Two screens hold it. Each organization's switch and computers are in Org settings > Connections ([connections](../../mailhub/org-connections/SKILL.md)), in the group **Remote access**. What is the same for every organization is in App settings > **Remote access**. The other computer adds this one from its homepage ([homepage](../../app-shell/homepage/SKILL.md), Remote engines).

## An organization's switch

**Let other computers open this organization** is off for every organization at first. A computer the user adds can then use this organization as the user does: read it, message its agents, answer questions and change its settings. Its agents keep running on this computer, with this computer's accounts and folders.

Adding a computer is like giving it SSH access to this one. Through the organization's agents it can run commands and read or change any file the user's account can, outside the organization too. So the user adds only computers, and people, they would trust with this whole computer. A computer that was let in is shown the organizations it was given and no other, and its window cannot change this computer's app-wide settings. Both keep its work in what was shared. Neither is a wall around the rest of the computer: say so when a user asks whether a shared organization is isolated.

Turning the switch on goes in this order and stops at the first No:

1. Orgtree checks that another computer could reach this one. If none could, the switch stays off and says why, for example "Tailscale is not running on this computer, so no other computer could reach it. Start Tailscale, or choose another place for remote access to listen (App settings, Remote access)."
2. On Windows, when a firewall rule is needed and not there yet, Windows asks for an administrator's permission to add it. A No leaves the switch off. With **This computer only** as the one place to listen, no rule is needed and Windows is not asked.
3. The switch turns on and this computer starts to listen.

While it is on, the group shows these rows:

| Row | What it is |
| --- | --- |
| **Address** | Where the other computer connects, with **Copy**. There is one row for each place it listens. **Address on this private network** is marked as not encrypted (http). The address `http://127.0.0.1:(port)` is marked "This computer only: for an SSH tunnel or a local https proxy": the other computer types the tunnel's or the proxy's address, not this one. When this computer cannot listen, the reason stands here: the port is taken by another program, or the computer has no address other computers could reach. |
| **Windows Firewall is blocking this** | Shown when Orgtree reads that the rules are missing. **Allow** asks Windows again. |
| **Computers** | Every computer that has this organization: the name others see for it, what the computer calls itself, when it was added, and "connected since" or when it was last seen. **Revoke** asks first. It takes the computer out of every organization of this desktop, not only this one, and ends its connections at once. It cannot take back what was copied or changed while the computer had access: a user who stopped trusting it should also change the sign-ins and keys on this computer, as after removing somebody's SSH key. |
| **Let another computer in** | **Add a computer...** opens the dialog below. |

Turning the switch off disconnects the computers that are connected (the question says how many lose it) and keeps the list, so turning it on again lets the same computers back in.

While another computer is connected, the organization's status bar shows a chip, "1 computer connected", with who in its tooltip. A click opens this tab.

## Add a computer

Each opening of the dialog makes one new code.

- **Address**: this computer's address, with Copy: its Tailscale address when Tailscale is chosen, else its address on the private network. It is never `127.0.0.1`, which to the other computer is itself. With **This computer only** as the one place it listens, the row says to send the tunnel's address instead (the https address the proxy or tunnel gives, or `http://127.0.0.1:(port)` for an SSH tunnel), and there is no **Both in one line**: the code is sent beside that address.
- **One-time code**: shown once, here. It is valid for 15 minutes and for one computer. Closing the dialog does not withdraw it. At most five codes are open for an organization, and an organization holds at most 32 computers.
- **Both in one line**: the address and the code together, with **Copy both**, to send to whoever sits at the other computer.
- **Or a computer you already added**: the computers that have another organization of this desktop. **Give access** adds this organization to one of them at once, with no code.

On the other computer: homepage > **Add a remote engine...**, then paste the line into Address, which fills Address and Token, or type the address and put the code into Token. A code that was used or has run out answers "That code was already used or has run out. Ask for a new one." The connection is named after this computer and lists only the organizations it was given. One that is given later appears by itself. Its Connection details says "these organizations only".

## App settings > Remote access

The tab is listed on a desktop's own engine only.

| Control | Default | Effect |
| --- | --- | --- |
| **Where it listens** | Tailscale | Three switches, each by itself; at least one stays on. **Tailscale**: encrypted, both computers in one tailnet. **This private network**: a home network or a trusted VPN, plain http, which is not encrypted, so anyone on it can read what travels, the token included. **This computer only**: `127.0.0.1`, for an SSH tunnel or a local https proxy (Caddy, cloudflared, ngrok) that carries the connection here; nothing else can reach it. It never listens on a public address by itself. |
| **Port** | 7431 | A number from 1024 to 65535. |
| **Now** | | What this computer does now: "Not listening: nothing is shared", "Listening" with each address, "Waiting for an address" or "Cannot listen", with the reason. |
| **Stop all remote access** | | After a question, turns every organization's switch off and stops listening. The lists of computers stay. |

Under **Organizations other computers can open**, each shared organization is named with how many computers it has and how many are connected. The switch itself stays in that organization's settings.

Nothing listens while no organization is shared. There are two firewall rules: one for Tailscale's addresses, added only while Tailscale is chosen, and one for the local subnet on Private networks, added only with the private-network choice. Both are limited to the port and to Orgtree's engine. **This computer only** needs none. Changing the port, or switching Tailscale or the private network, while something is shared asks Windows first, and a No leaves everything as it was. A rule whose place was switched off is taken out in the same step. Switching **This computer only** by itself asks nothing, because it needs no rule. **Windows Firewall is blocking this** with **Allow** appears here too when the rules are missing. When nothing is shared and the rules are still there, **Windows Firewall still has the rules for remote access** offers **Remove the rules**. They are asked for again when remote access is next turned on.

## Without Tailscale

Both ways use **This computer only**; the user guide's section "Without Tailscale" has the steps.

- **SSH tunnel:** the other computer runs `ssh -N -L 7431:127.0.0.1:7431 user@hosting-computer` and adds the remote engine at `http://127.0.0.1:7431`.
- **https tunnel or proxy:** Caddy, Cloudflare Tunnel or ngrok on the hosting computer hands https on to `http://127.0.0.1:7431`; the other computer adds the `https://` address. The certificate must be one the other computer trusts.

Every caller then arrives from this computer itself. The door answers an address that keeps showing tokens it does not know "too many refused requests" for a minute, but a computer that was let in, and a valid one-time code, are never shut out by that.

## In the other computer's window

An organization opened from another computer behaves like any remote organization: folders and files are the hosting computer's, and other people's actions carry their name. App settings there shows the hosting computer's settings to read; a change is refused by that computer, which says so. When the hosting desktop stops sharing an organization, its window on the other computer says "(name) no longer shares this organization."

Streamer mode treats the addresses and a computer's own name as host fields, the code and the line with address and code as secrets, and the name others see as an outside name.

## See also

- [orgtree-org-connections](../../mailhub/org-connections/SKILL.md)
- [orgtree-homepage](../../app-shell/homepage/SKILL.md)
