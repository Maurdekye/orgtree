// User 2026-10-19: white to lime over 0-3s, then each decade advances one stop.
const stops = [[3, '#b6ff00'], [30, '#4f9b1d'], [300, '#a6b51c'], [3000, '#efa02a'],
  [30000, '#df4b28'], [300000, '#32140f'], [3000000, '#000000']] as const
const rgb = (hex: string) => hex.slice(1).match(/../g)!.map(value => parseInt(value, 16))

/** Log10 interpolation in RGB, applied directly to text (user 19:24Z). */
export function slotTimeStyle(seconds: number): { color: string } {
  const at = Number.isNaN(seconds) ? 0 : Math.max(0, seconds)
  let color: string = stops[0][1]
  if (at < 3) color = '#' + rgb(stops[0][1]).map(value =>
    Math.round(255 + (value - 255) * at / 3).toString(16).padStart(2, '0')).join('')
  if (at >= stops.at(-1)![0]) color = stops.at(-1)![1]
  else if (at > 3) {
    const end = stops.findIndex(stop => stop[0] >= at)
    const [lo, a] = stops[end - 1], [hi, b] = stops[end]
    const blend = Math.log10(at / lo) / Math.log10(hi / lo)
    const x = rgb(a), y = rgb(b)
    color = '#' + x.map((value, i) => Math.round(value + (y[i] - value) * blend)
      .toString(16).padStart(2, '0')).join('')
  }
  return { color }
}
