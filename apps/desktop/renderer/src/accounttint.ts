/** Account tints (multi-account D5, user rule 21:09): agents on different
 * accounts of the SAME provider get lighter/darker variants of that
 * provider's colour — like alternate team colours for one fighter — with
 * the provider's base identity intact and work-status colours untouched.
 *
 * TWO bounds by construction: (i) LIGHTNESS-ONLY variation — the hue never
 * moves, so a variant can never drift into another provider's hue band
 * (the cross-provider separation the design requires reduces to the base
 * palette's own distinct hues); (ii) lightness is clamped to [26%, 78%] so
 * every variant keeps contrast with status symbols and the dark canvas.
 *
 * ORDINALS NEVER REINDEX (allocated once in the registry), so the mapping
 * here is pure and stable: ordinal 1 wears the base colour; 2 is lighter,
 * 3 darker, 4 lighter still, alternating outward in 9% lightness steps. */

function hexToHsl(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const v = parseInt(m[1], 16)
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255,
    b = (v & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
    : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

export function accountTint(baseHex: string, ordinal: number): string {
  const hsl = hexToHsl(baseHex)
  if (!hsl || !Number.isFinite(ordinal) || ordinal <= 1) return baseHex
  const [h, s, l] = hsl
  // 2 → +1 step, 3 → −1, 4 → +2, 5 → −2 … alternating outward
  const k = Math.floor(ordinal / 2) * (ordinal % 2 === 0 ? 1 : -1)
  const lightness = Math.min(0.78, Math.max(0.26, l + k * 0.09))
  return `hsl(${h.toFixed(1)}deg ${(s * 100).toFixed(1)}% ${(lightness * 100).toFixed(1)}%)`
}
