# Orgtree 4.5.4

Orgtree 4.5.4 lets the mail hub you host translate messages between people who read in different languages, shows agents the language each person reads in, and lets you mention outside contacts and orgs from the @ menu. It bundles Mail hub 2.4.0.

## Before you upgrade

- **The bundled mail hub's upgrade is one-way.** Mail hub 2.4.0 upgrades its database (schema 13) on first start. After that, an older hub cannot open it: if you host the mail hub on this computer and go back to Orgtree 4.5.3 or earlier, the hub does not start and reports that its database is newer than it understands. To get it running again, install Orgtree 4.5.4 or later again, or restore a backup of the hub's data taken before the upgrade (mail that arrived after that backup is lost). Orgtree does not take this backup for you, so make one first if you might want to go back.
- **Translation is off until you turn it on**, and it needs your own Anthropic API key (see below). Nothing is sent anywhere until you do.

## Translation (hosted mail hub)

- **The hub you host can translate mail between people.** In **App settings > Mail hub > Hosting**, the new **Translation** group turns on **Translate messages between people** and sets a **Default language**, the **Model** (Claude Haiku 5.5 by default), a **Monthly limit (USD)** and an **Anthropic API key**. Changes apply without restarting the hub.
- **It needs an Anthropic API key.** Create one in the Anthropic Console (it starts with `sk-ant-api`); a Claude.ai subscription doesn't cover the API. The key is stored on this computer, never shown again, and removed with **Forget it**. **Message text leaves this computer** to be translated by Anthropic.
- **Readers opt in.** Only people who pick a language in Hubchat (Hubchat 1.3.0 or later) receive translations, each in their own language; they can always show the original. People who haven't picked a language get every message as written. A sender who hasn't picked a language is taken to write in the hub's Default language.
- **People to people by default.** Agents and organizations write to people in their language themselves, so their messages arrive as written. Turn on **Translate messages from agents** to translate those for people too. Mail to agents is never translated.
- **Mentions are never changed.** The message goes to the translator exactly as written. If a translation changes or drops any @mention, the reader gets the original instead.
- **You can see what it costs.** With translation on, the group shows this month's spend and messages translated, warns at 80% of the limit and when the limit is reached (mail is then delivered untranslated until the month ends or you raise the limit), asks for a key when none is stored, and says when Anthropic refused the key.
- **Mail is never held back.** Messages are delivered at once, untranslated if need be, and the translation follows; a phone notification waits up to 4 seconds for it.

## A person's language

- **Agents see the language a person reads in.** Mail from an outside person names their language next to their address (for example `language: he`), so agents can answer in it. Nothing is shown for people who haven't picked one.
- **So do you.** Hovering any link to a person shows their language.
- Only well-formed language codes are shown, whichever hub reports them.

## Mentions

- **Mention outside contacts and orgs.** The @ menu now offers `@net:` contacts your hubs list and `@org:` orgs on this computer. Typing `@net:` or `@org:` lists only those. Picking one inserts the address and sends nothing.
- **Recent ones come first.** Contacts and orgs are ranked by the latest mail exchanged with them or mention of them in mail, like everything else in the menu.

## Untested

- Translation has been tested with a simulated translation service only. A real Anthropic key end to end, delivery to a real phone and its system notifications have not been tested yet.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
