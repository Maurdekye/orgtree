/** How the Usage modal lays its account cards out: every account of one
 *  provider together, one provider group after another.
 *
 *  ⚠ THE MODAL USED TO INTERLEAVE THEM, and not by accident — it rendered the
 *  four HOST lanes first (Claude, Codex, Antigravity, OpenRouter) and then
 *  every registered account in registry order underneath. A machine with two
 *  Claude logins and one Codex login therefore read Claude · Codex ·
 *  Antigravity · <second Claude>, so the two accounts a reader most wants to
 *  compare sat furthest apart. Grouping is a LAYOUT rule and nothing else:
 *  it reorders whole cards and never touches what a card says.
 *
 *  Kept out of App.tsx because it is a pure data rule with edge cases of its
 *  own — an unknown provider id, a provider that appears only in the registry,
 *  two cards of the same provider that must not swap — and those are worth
 *  testing without mounting a modal. */

/** The ticket's group order. A provider not named here is not unknown to the
 *  app (OpenRouter is not), it simply has no ruled position, so it sorts after
 *  these three by the rule below. */
export const USAGE_PROVIDER_ORDER: readonly string[] = ['claude', 'openai', 'google']

/** The only thing the ordering reads off a card. Deliberately structural: the
 *  caller keeps its own rendered node beside it, so this file never learns
 *  anything about how a card looks. */
export interface ProviderKeyed {
  provider: string
}

/** Group `cards` by provider, in USAGE_PROVIDER_ORDER, then by the order in
 *  which any remaining provider first appears in `cards`.
 *
 *  ⚠ TWO PROPERTIES, AND BOTH ARE LOAD-BEARING.
 *
 *  Within a group the input order survives EXACTLY — the caller's existing
 *  order (host lane first, then the registry's own row order) is the account
 *  order the ticket says to preserve, so this must not impose one of its own.
 *  The `a.at - b.at` tiebreak is what guarantees that, rather than trusting
 *  the engine's sort to be stable.
 *
 *  Ungrouped providers cannot all share one rank. If they did, a stable sort
 *  would leave them in input order — which keeps them interleaved, the exact
 *  defect this exists to fix. Each gets its own rank on FIRST APPEARANCE, so
 *  the groups are whole and their order still derives from the input rather
 *  than from a name comparison that would reshuffle the four host lanes. */
export function groupByProvider<T extends ProviderKeyed>(cards: readonly T[]): T[] {
  const ranked = new Map<string, number>()
  const rankOf = (provider: string): number => {
    const known = USAGE_PROVIDER_ORDER.indexOf(provider)
    if (known >= 0) return known
    const seen = ranked.get(provider)
    if (seen !== undefined) return seen
    // first appearance of an ungrouped provider claims the next rank after
    // the ruled ones — never a rank that could collide with them
    const next = USAGE_PROVIDER_ORDER.length + ranked.size
    ranked.set(provider, next)
    return next
  }
  return cards
    .map((card, at) => ({ card, at, rank: rankOf(card.provider) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.card)
}
