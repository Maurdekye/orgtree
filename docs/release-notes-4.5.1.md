# Orgtree 4.5.1

Orgtree 4.5.1 lets questions carry formatting, retries Codex rate limits instead of freezing agents, keeps query values out of normal logs and gives Gemini Carbon its colour.

## Questions

- **Questions are formatted like chat.** The text of a question an agent asks you, and each option's description, now show Markdown, LaTeX and clickable mention links, the same as chat messages. That holds on the desk, in the inbox, in the Attention view, in docket item questions and on the answered card. Option labels stay plain, and a plain question looks exactly as before. Clicking a description's text still picks that option; clicking a mention inside it opens what it points at without picking.

## Agents and models

- **A Codex rate limit no longer freezes an agent for an hour.** When OpenAI answers "429 Too Many Requests" and the account's usage is not used up, the agent waits briefly and retries its request: it honours the provider's suggested wait, otherwise waits up to 5 minutes, and tries up to 5 times. Its status says it is rate-limited and when it retries. A real usage limit still freezes the agent until the window resets, as before.
- **Gemini Carbon is light charcoal grey.** When Antigravity offers Gemini Carbon, its tier shows in a light slate grey that stays distinct from the other model colours and from interface greys in every theme.

## Logs and docket

- **Normal logs keep query values out.** Each logged request keeps its route and parameter names but replaces the values with `****`, so a panel playing a file no longer writes that file's path into the log. Verbose logging still records everything, for debugging.
- **The idle docket reminder skips deploy_ready items,** as it already skipped blocked ones. Finished work waiting for a release no longer wakes its owner every 20 minutes.
