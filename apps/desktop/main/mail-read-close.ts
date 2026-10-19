/** The renderer adds real pending read saves to this event. executeJavaScript
 * awaits the returned promise, rather than just dispatchEvent's boolean. */
export function rendererMailReadFlushScript(event = 'orgtree:flush-mail-reads'): string {
  return `(async () => {
    const pending = [];
    window.dispatchEvent(new CustomEvent(${JSON.stringify(event)}, {
      detail: { waitUntil: promise => pending.push(Promise.resolve(promise)) }
    }));
    await Promise.all(pending);
  })()`
}

/** Used inside the main window's ONE close listener, before close policy can
 * hide it, stop the engine or destroy its children. Child windows use the
 * same gate. A repeat click joins the drain; teardown happens only on retry. */
export function mailReadCloseGate(flush: () => Promise<unknown>, close: () => void,
  failed: (error: unknown) => void) {
  let draining = false, ready = false
  return (event: {preventDefault(): void}): boolean => {
    if (ready) { ready = false; return false }
    event.preventDefault()
    if (draining) return true
    draining = true
    void Promise.resolve().then(flush).then(() => {
      draining = false; ready = true; close()
    }, error => { draining = false; failed(error) })
    return true
  }
}
