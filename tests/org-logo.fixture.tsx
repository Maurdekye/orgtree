import { createRoot } from 'react-dom/client'
import { OrgPictureEditor } from '../apps/desktop/renderer/src/canvas/orgpicture'
import { applyTheme } from '../apps/desktop/renderer/src/themes'
import { applyContrast } from '../apps/desktop/renderer/src/contrast'

const W = window as any
const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16
const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#d99863'; ctx.fillRect(0, 0, 16, 16)
const png = canvas.toDataURL('image/png').split(',')[1]
let picture = false, revision = 0, chooser = 0
const saved: unknown[] = [], requests: string[] = [], errors: string[] = []
HTMLInputElement.prototype.click = function () { if (this.type === 'file') chooser++ }
W.addEventListener('error', (e: ErrorEvent) => errors.push(e.message))
W.fetch = async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input), location.origin); requests.push(url.pathname)
  let value: unknown
  if (W.fail) return new Response(JSON.stringify({ detail: 'Unsupported profile picture' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  if (url.pathname.endsWith('/preview')) value = { data: png, width: 16, height: 16 }
  else if (init?.method === 'POST') { const body = JSON.parse(String(init.body)); saved.push(body); picture = body.data !== null; value = picture ? { revision: 'new', data: png, sha256: 'a'.repeat(64), width: 16, height: 16, bytes: 96 } : null }
  else value = { owner: 17, picture: picture ? { revision: 'r' + revision, data: png, sha256: 'a'.repeat(64), width: 16, height: 16, bytes: 96 } : null }
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
const root = createRoot(document.getElementById('root')!)
W.proof = { saved, requests, errors, chooser: () => chooser,
  mount: (theme: string, contrast: string, hasPicture = false) => {
    applyTheme(theme); applyContrast(contrast); picture = hasPicture; revision++
    root.render(<main className="settings cfg" style={{ margin: '24px auto', width: 620, maxWidth: 'calc(100vw - 48px)', padding: 24 }}>
      <h2>Organization settings</h2><OrgPictureEditor slug="synthetic" name="Synthetic Org" revision={'r' + revision} />
    </main>)
  },
  select: (size = 3) => {
    const input = document.querySelector('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [{ size, arrayBuffer: async () => Uint8Array.from([7, 8, 9]).buffer }] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  },
  dispose: () => root.unmount(),
}
W.proof.mount('claude', 'charcoal')
