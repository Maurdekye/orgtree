// Injected before the unmodified production renderer. No React hooks or fake API.
export function installPaintProbe(config) {
  const now = () => performance.timeOrigin + performance.now()
  const state = { batches: [], receipts: [], actions: [], errors: [], frames: [], wsClosed: 0,
    feedFrom: null, feedUntil: null, suppressed: [], delayExecutions: [] }
  const received = new Map(), drawn = new Set(), pending = []
  let next = 0xb70001, active = null, tile = null, timer = null, lastRaf = null
  const max = 20000
  const fail = text => { if (state.errors.length < 20) state.errors.push(text) }
  function visible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false
    const r = el.getBoundingClientRect(), c = getComputedStyle(el)
    if (c.visibility !== 'visible' || c.display === 'none' || Number(c.opacity) === 0
        || r.width <= 0 || r.height <= 0 || r.right <= 0 || r.bottom <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false
    const x = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2))
    const y = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2))
    const top = document.elementFromPoint(x, y)
    return top === el || el.contains(top)
  }
  function queue(row) {
    if (state.batches.length + pending.length >= max) { fail('proof buffer overflow'); return }
    pending.push(row)
  }
  function check() {
    try {
      if (active?.clicked && !active.readyAt && active.ready()) {
        active.readyAt = now()
        queue({ type: 'action', name: active.name, clicked: active.clicked, readyAt: active.readyAt, delayMs: active.delayMs })
      }
      if (state.feedFrom != null) {
        // Track each marker, including holes. Require actual visible text Range,
        // not hidden mounted desks or stale text elsewhere in the page.
        const host = document.querySelector('.attn-desk .msgs')
        if (host) {
          const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
          let node
          while ((node = walker.nextNode())) for (const m of node.textContent.matchAll(/\[\[m(\d+)\]\]/g)) {
            const id = Number(m[1])
            if (!received.has(id) || drawn.has(id)) continue
            const range = document.createRange(); range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length)
            const r = range.getBoundingClientRect(), hr = host.getBoundingClientRect()
            const x = Math.max(r.left, hr.left, 0), y = Math.max(r.top, hr.top, 0)
            if (r.width && r.height && x < Math.min(r.right, hr.right, innerWidth)
                && y < Math.min(r.bottom, hr.bottom, innerHeight)
                && host.contains(document.elementFromPoint(x + 1, y + 1))) {
              drawn.add(id); queue({ type: 'feed', m: id, received: received.get(id), readyAt: now() })
            }
          }
        }
      }
    } catch (e) { fail(String(e)) }
  }
  function tick(t) {
    if (lastRaf !== null && state.frames.length < max) state.frames.push(t - lastRaf)
    lastRaf = t
    check()
    if (pending.length && document.body) {
      const rows = pending.splice(0), delay = Math.max(0, ...rows.map(r => r.delayMs || 0))
      if (delay) {
        const start = now(); while (now() - start < delay) { /* deliberate renderer stall: negative control */ }
        state.delayExecutions.push({ start, elapsed: now() - start })
      }
      if (!tile) {
        tile = document.createElement('div'); tile.id = 'scale-paint-proof'
        tile.setAttribute('aria-hidden', 'true')
        tile.style.cssText = 'position:fixed!important;left:0!important;top:0!important;width:12px!important;height:12px!important;z-index:2147483647!important;pointer-events:none!important;opacity:1!important;transition:none!important;animation:none!important;transform:none!important;'
        document.body.appendChild(tile)
      }
      const id = next++, batch = { id, at: now(), rows }
      state.batches.push(batch)
      if (rows.some(r => r.name === 'suppressed-paint-control')) state.suppressed.push(id)
      else tile.style.backgroundColor = `rgb(${id & 255},${id >> 8 & 255},${id >> 16 & 255})`
    }
    timer = requestAnimationFrame(tick)
  }
  addEventListener('click', event => {
    if (!active || active.clicked || !active.element.contains(event.target)) return
    if (!event.isTrusted) { fail('untrusted action click'); return }
    active.clicked = now()
  }, true)
  const WS = window.WebSocket
  window.WebSocket = class extends WS {
    constructor(...args) {
      super(...args)
      this.addEventListener('close', () => { state.wsClosed++ })
      this.addEventListener('message', event => {
        const at = now()
        if (state.feedFrom == null || (state.feedUntil != null && at > state.feedUntil + 5000)) return
        try {
          const row = JSON.parse(event.data)
          if (row.type !== 'node_stream' || row.node !== config.agent) return
          for (const m of String(row.text || '').matchAll(/\[\[m(\d+)\]\]/g)) {
            const id = Number(m[1])
            if (!received.has(id)) {
              if (state.receipts.length >= max) { fail('receipt buffer overflow'); return }
              received.set(id, at); state.receipts.push({ m: id, at })
            }
          }
        } catch { /* non-JSON websocket heartbeat */ }
      })
    }
  }
  addEventListener('error', e => fail(e.message))
  window.__paintProbe = {
    state, visible,
    arm(name, selector, readySource, delayMs = 0) {
      const element = document.querySelector(selector)
      if (!element) throw Error('missing click target: ' + selector)
      element.scrollIntoView({ block: 'center', inline: 'center' })
      if (!visible(element)) throw Error('click target invisible/occluded: ' + selector)
      const ready = new Function('visible', `return (${readySource})`).bind(null, visible)
      if (ready()) throw Error('postcondition already true: ' + name)
      const r = element.getBoundingClientRect()
      active = { name, element, ready, clicked: null, readyAt: null, delayMs }
      state.actions.push({ name, armed: now() })
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    },
    finish() { active = null },
    feedStart() { state.feedFrom = now(); return state.feedFrom },
    feedEnd() { state.feedUntil = now(); return state.feedUntil },
    snapshot() { return JSON.parse(JSON.stringify(state)) },
    stop() { cancelAnimationFrame(timer) },
  }
  requestAnimationFrame(tick)
}
