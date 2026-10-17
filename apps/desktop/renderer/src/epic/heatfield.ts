export interface HeatPoint { x: number; y: number; flux?: number }
export const HEAT_FLUX = 0.30
export const HEAT_IMPULSE = 0.18
export const HEAT_CAP = 1
const LOSS = 0.35, DIFFUSION = 1800

/** Backward-Euler heat equation, solved by Jacobi ping-pong iteration.
 * World-space cells, no-flux edges, fixed source flux and ambient loss.
 * At most 96² cells; coefficients use actual world cell dimensions. */
export class HeatField {
  readonly cols: number
  readonly rows: number
  values: Float32Array
  private scratch: Float32Array
  constructor(readonly x: number, readonly y: number, readonly width: number, readonly height: number) {
    this.cols = Math.max(1, Math.min(96, Math.ceil(width / 32)))
    this.rows = Math.max(1, Math.min(96, Math.ceil(height / 32)))
    this.values = new Float32Array(this.cols * this.rows)
    this.scratch = new Float32Array(this.values.length)
  }
  private index(x: number, y: number): number {
    const col = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.x) / this.width * this.cols)))
    const row = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.y) / this.height * this.rows)))
    return row * this.cols + col
  }
  at(x: number, y: number): number { return this.values[this.index(x, y)]! }
  impulse(point: HeatPoint, amount = HEAT_IMPULSE): void {
    const i = this.index(point.x, point.y)
    this.values[i] = Math.min(HEAT_CAP, this.values[i]! + Math.max(0, amount))
  }
  get peak(): number { return this.values.reduce((a, b) => Math.max(a, b), 0) }
  resample(previous: HeatField): void {
    for (let j = 0; j < this.rows; j++) for (let i = 0; i < this.cols; i++) {
      const x = this.x + (i + 0.5) * this.width / this.cols, y = this.y + (j + 0.5) * this.height / this.rows
      if (x >= previous.x && y >= previous.y && x < previous.x + previous.width && y < previous.y + previous.height)
        this.values[j * this.cols + i] = previous.at(x, y)
    }
  }
  private sources(points: readonly HeatPoint[]): Float32Array {
    const q = new Float32Array(this.values.length)
    for (const p of points) q[this.index(p.x, p.y)]! += p.flux ?? HEAT_FLUX
    return q
  }
  advance(seconds: number, points: readonly HeatPoint[]): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return
    // After 60 s the transient is < exp(-LOSS*60), even without diffusion.
    // Solve its steady limit rather than replaying thousands of hidden frames.
    if (seconds > 60) { this.equilibrium(points); return }
    const q = this.sources(points)
    for (let left = seconds; left > 1e-8; left -= 0.25) this.solve(q, Math.min(left, 0.25), false)
  }
  equilibrium(points: readonly HeatPoint[]): void {
    this.values.fill(0)
    this.solve(this.sources(points), 1, true)
  }
  private solve(q: Float32Array, dt: number, steady: boolean): void {
    const old = this.values.slice()
    let a = this.values, b = this.scratch
    const ax = DIFFUSION * dt / (this.width / this.cols) ** 2
    const ay = DIFFUSION * dt / (this.height / this.rows) ** 2
    const base = steady ? 0 : 1
    const denominator = base + 2 * ax + 2 * ay + LOSS * dt
    for (let iteration = 0; iteration < (steady ? 256 : 24); iteration++) {
      let change = 0
      for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x
        const sum = ax * (a[x ? i - 1 : i]! + a[x + 1 < this.cols ? i + 1 : i]!)
          + ay * (a[y ? i - this.cols : i]! + a[y + 1 < this.rows ? i + this.cols : i]!)
        const next = Math.min(HEAT_CAP, Math.max(0, (base * old[i]! + dt * q[i]! + sum) / denominator))
        b[i] = next
        change = Math.max(change, Math.abs(next - a[i]!))
      }
      ;[a, b] = [b, a]
      if (change < 1e-6) break
    }
    this.values = a; this.scratch = b
  }
}
