---
name: orgtree-hubchat
description: "Explain Hubchat\u0027s human chat role and how conversations reach Orgtree organizations."
---

Up: [orgtree-mailhub](../SKILL.md)

# Human chat through a hub

Hubchat is the human chat client for people and organizations on a mail hub. It is available on the phone and on a PC. It is distinct from the hub's operator web page, which exposes stored correspondence to its operator; do not call that operator page the phone chat client.

For a developer team, the repository recommends each person install Orgtree and Hubchat and connect both to a shared standalone hub reachable on the company's private network. The built-in hub suits individuals and small teams; this is a deployment recommendation, not a client-count limit or a required migration.

In Hubchat use **Settings > Hubs > Add a hub** with the operator's relay-only address. Use the directory to find people and Orgtree orgs. Each person has a person identity; each Orgtree org has its own organization identity. Sharing a hub does not merge identities or establish ownership of an org. To carry your identity to another device use **Settings > Devices > Link a device**, rather than sharing ownership secrets or creating another identity unintentionally.

## How an organization receives and answers

A person's conversation with an Orgtree org is outside mail to that org. The routing/holder rules live in `orgtree-org-inbox` (orgtree-working › mail), and sender authority lives in `orgtree-external-mail` (orgtree-working › mail). Human composition is in Hubchat; Orgtree's org inbox is a viewer of retained correspondence.

An agent must actually send its response to the person's `@net:` address. Local assistant text, a desktop question card, and a presented-document card do not automatically become a Hubchat reply. The message tool supplies hub question options and reply references; see `orgtree-tool-message` (orgtree-working › mail). Files attached to mail use the transfer path, whose progress and custody controls are described by `orgtree-tool-transfers` (orgtree-working › mail), rather than local file-card delivery.

Connection, upload, hub acceptance, agent delivery and a person's read are different stages. A queued response can still be waiting on files or connectivity. Report only the stage supported by the send/transfer result; do not assume a recipient has read something because a local tool returned success.

## Phone entrypoint and availability

For the built-in hub, use [Connect your phone](../phone-link/SKILL.md) for the current download/setup sequence and link management. Other devices normally use the relay-only door on port 7371; the hosting page owns port/exposure settings. That PC and hub must stay available for communication through it. A standalone team hub can stay available independently of a developer's desktop engine, but it does not run that developer's provider sessions or agents.

This page describes the integration checked in Orgtree source and repository setup docs. It does not establish every current Hubchat app control or notification behavior; use the Hubchat setup guide linked by the phone panel for device-specific help.

## See also

- [orgtree-phone-link](../phone-link/SKILL.md)
