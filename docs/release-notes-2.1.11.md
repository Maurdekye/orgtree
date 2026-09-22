# Orgtree 2.1.11

Claude Opus 5.5 is now the default Opus model. Existing Opus agents using the
default move to 5.5; agents explicitly pinned to Opus 5 or 4.8 keep that version.
All three versions are available in the agent's configuration menu. Custom
organization model IDs, account bindings and effort settings stay unchanged.
The Opus seat now costs four credits. Existing organizations using the shipped
five-credit price migrate to four, returning one credit to the parent's free
allocation per Opus child. Custom organization prices remain unchanged.

The managed Claude Code pin is updated to 2.1.280, which adds Opus 5.5 support
and its usage pricing. The canonical model ID is `claude-opus-5-5`. Anthropic
lists a 1M context window, 128K maximum output, always-on adaptive thinking and
medium default effort. Orgtree continues to send the agent's configured effort.
API pricing is $4 per million input tokens, $20 per million output tokens,
$5/$8 for five-minute/one-hour cache writes and $0.20 for cache reads.
Orgtree records the CLI's reported cost; all selectable Opus versions share
the four-credit tier.

Sources verified September 22, 2026:

- [Anthropic model overview](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Claude Code 2.1.280 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21280)

This stable patch contains no private v3 prototype changes.

Additional `gpt-6-sol` and `gpt-6-luna` selections become available when the
selected Codex account's model inventory lists the exact identifier. Sol now
costs two seat credits and Luna 0.1, for both existing and new selections.
Saved organizations using the shipped five/0.2-credit defaults migrate to
two/0.1; custom prices and grants remain unchanged. GPT-6 Luna uses the direct
account route, preserving its exact requested model ID.

GPT-6 API pricing per million input/cached-input/output tokens is
$2.00/$0.20/$10.00 for Sol and $0.10/$0.01/$0.60 for Luna. These release rates
were supplied by the user on September 22. Existing Sol (`gpt-5.6-sol`) and
Luna (`gpt-5.6-luna`) identifiers, API rates and Luna reserve routing remain.
Their API rates are $4.00/$0.40/$20.00 and $0.20/$0.02/$1.20 respectively;
API rates are specific to the selected model, while seat prices follow the
latest tier. No version-specific seat-cost infrastructure is added.
