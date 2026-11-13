---
name: orgtree-app-remote-access
description: "Explain remote access: letting other computers open an organization of this desktop, adding a computer, where it listens and the firewall rules."
---

Up: [orgtree-app-settings](../SKILL.md)

# Remote access

Remote access lets another computer that runs Orgtree open an organization of this desktop and work in it as the user does. It is off until the user turns it on for one organization, and it is the user's alone: no agent tool turns it on, adds a computer or makes a code. Agents explain these controls; the user operates them. It exists on a desktop's own engine only. A standalone (headless) engine has client tokens instead, and an organization that itself runs on a remote engine cannot be passed on, so neither shows these controls.

Two screens hold it. Each organization's switch and computers are in Org settings > Connections ([connections](../../mailhub/org-connections/SKILL.md)), in the group **Remote access**. What is the same for every organization is in App settings > **Remote access**. The other computer adds this one from its homepage ([homepage](../../app-shell/homepage/SKILL.md), Remote engines).

## An organization's switch

**Let other computers open this organization** is off for every organization at first. A computer the user adds can then use this organization as the user does: read it, message its agents, answer questions and change its settings. Its agents keep running on this computer, with this computer's accounts and folders, so the user adds only computers they trust with that. A computer that was let in sees the organizations it was given and no other, and it cannot change this computer's app-wide settings.

Turning the switch on goes in this order and stops at the first No:

1. Orgtree checks that another computer could reach this one. If none could, the switch stays off and says why, for example "Tailscale is not running on this computer, so no other computer could reach it. Start Tailscale, or let remote access also use this private network (App settings, Remote access)."
2. When the firewall rules are not there yet, Windows asks for an administrator's permission to add them. A No leaves the switch off.
3. The switch turns on and this computer starts to listen.

While it is on, the group shows these rows:

| Row | What it is |
| --- | --- |
| **Address** | Where the other computer connects, with **Copy**. With the private network chosen there is a second row, **Address on this private network**, marked as not encrypted (http). When this computer cannot listen, the reason stands here: the port is taken by another program, or the computer has no address other computers could reach. |
| **Windows Firewall is blocking this** | Shown when Orgtree reads that the rules are missing. **Allow** asks Windows again. |
| **Computers** | Every computer that has this organization: the name others see for it, what the computer calls itself, when it was added, and "connected since" or when it was last seen. **Revoke** asks first. It takes the computer out of every organization of this desktop, not only this one, and ends its connections at once. |
| **Let another computer in** | **Add a computer...** opens the dialog below. |

Turning the switch off disconnects the computers that are connected (the question says how many lose it) and keeps the list, so turning it on again lets the same computers back in.

While another computer is connected, the organization's status bar shows a chip, "1 computer connected", with who in its tooltip. A click opens this tab.

## Add a computer

Each opening of the dialog makes one new code.

- **Address**: this computer's address, with Copy.
- **One-time code**: shown once, here. It is valid for 15 minutes and for one computer. Closing the dialog does not withdraw it. At most five codes are open for an organization, and an organization holds at most 32 computers.
- **Both in one line**: the address and the code together, with **Copy both**, to send to whoever sits at the other computer.
- **Or a computer you already added**: the computers that have another organization of this desktop. **Give access** adds this organization to one of them at once, with no code.

On the other computer: homepage > **Add a remote engine...**, then paste the line into Address, which fills Address and Token, or type the address and put the code into Token. A code that was used or has run out answers "That code was already used or has run out. Ask for a new one." The connection is named after this computer and lists only the organizations it was given. One that is given later appears by itself. Its Connection details says "these organizations only".

## App settings > Remote access

The tab is listed on a desktop's own engine only.

| Control | Default | Effect |
| --- | --- | --- |
| **Where it listens** | Tailscale only | **Tailscale only**, or **Tailscale and this private network**. Tailscale encrypts what travels. On a private network it is plain http, which is not encrypted. It never listens on a public address. |
| **Port** | 7431 | A number from 1024 to 65535. |
| **Now** | | What this computer does now: "Not listening: nothing is shared", "Listening" with each address, "Waiting for an address" or "Cannot listen", with the reason. |
| **Stop all remote access** | | After a question, turns every organization's switch off and stops listening. The lists of computers stay. |

Under **Organizations other computers can open**, each shared organization is named with how many computers it has and how many are connected. The switch itself stays in that organization's settings.

Nothing listens while no organization is shared. There are two firewall rules: one for Tailscale's addresses, and one for the local subnet on Private networks, which is added only with the private-network choice. Both are limited to the port and to Orgtree's engine. Changing the port or where it listens while something is shared asks Windows first, and a No leaves everything as it was. **Windows Firewall is blocking this** with **Allow** appears here too when the rules are missing. When nothing is shared and the rules are still there, **Windows Firewall still has the rules for remote access** offers **Remove the rules**. They are asked for again when remote access is next turned on.

## In the other computer's window

An organization opened from another computer behaves like any remote organization: folders and files are the hosting computer's, and other people's actions carry their name. App settings there shows the hosting computer's settings to read; a change is refused by that computer, which says so. When the hosting desktop stops sharing an organization, its window on the other computer says "(name) no longer shares this organization."

Streamer mode treats the addresses and a computer's own name as host fields, the code and the line with address and code as secrets, and the name others see as an outside name.

## See also

- [orgtree-org-connections](../../mailhub/org-connections/SKILL.md)
- [orgtree-homepage](../../app-shell/homepage/SKILL.md)
