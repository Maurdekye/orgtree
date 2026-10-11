/** Main-process only. The native probe checks stamped process identities; an
 * HTTP timeout alone never becomes proof that a component died. */
import {execFile} from 'node:child_process'
import type {CredentialBridge} from './credential-bridge'

export class CoreLifecycle {
  private busy = false
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly binary: string, private readonly root: string,
    private readonly bridge: CredentialBridge,
    private readonly endpoint: () => {origin: string; token: string},
    private readonly shutdown: () => void) {}

  private native(action: 'begin' | 'status'): Promise<{stopped?: boolean}> {
    return new Promise((resolve, reject) => {
      execFile(this.binary, ['core-control', action, this.root], {windowsHide: true, timeout: 5000, maxBuffer: 8192},
        (error, stdout) => {
          if (error) { reject(new Error('The previous Orgtree session has not finished stopping. Wait, then reopen Orgtree.')); return }
          try { resolve(action === 'begin' ? {} : JSON.parse(stdout)) } catch { reject(new Error('Invalid lifecycle reply')) }
        })
    })
  }
  async begin(automatic = false): Promise<boolean> {
    // A late login launch is another automatic retry, not the user's explicit
    // request to open a fresh application after a failed cohort.
    if (automatic) return (await this.native('status')).stopped === true
    await this.native('begin'); return false
  }
  async transition(installing = false): Promise<void> {
    const e = this.endpoint()
    if (await this.bridge.core(e.origin, e.token, installing ? 'install' : 'transition')) {
      this.shutdown(); throw new Error('Orgtree is stopping because a required process exited.')
    }
  }
  async complete(): Promise<void> {
    const e = this.endpoint()
    if (await this.bridge.core(e.origin, e.token) || await this.bridge.core(e.origin, e.token, 'complete')) this.shutdown()
  }
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, 2000)
    this.timer.unref()
    void this.tick()
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      // The local journal also covers the engine disappearing before the HTTP
      // registration can answer. No retry is allowed to clear its stop record.
      if ((await this.native('status')).stopped) { this.shutdown(); return }
      const e = this.endpoint()
      if (e.origin && await this.bridge.core(e.origin, e.token)) this.shutdown()
    } catch { /* uncertain probes retry; they do not declare process death */ }
    finally { this.busy = false }
  }
}
