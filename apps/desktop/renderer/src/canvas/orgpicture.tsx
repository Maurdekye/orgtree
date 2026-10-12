import { useEffect, useRef, useState } from 'react'
import { getOrgPicture, previewOrgPicture, setOrgPicture, type OrgPicture, type OrgPictureCrop } from '../api'
import { SetBlock, SetGroup } from './settingskit'

export function OrgPictureEditor({ slug, revision }: { slug: string; revision?: string | null }) {
  const [loaded, setLoaded] = useState<{ slug: string; owner: number; picture: OrgPicture | null } | null>(null)
  const [selected, setSelected] = useState<{ data: string; src: string; width: number; height: number } | null>(null)
  const [crop, setCrop] = useState<OrgPictureCrop>({ x: .5, y: .5, size: 1 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const intent = useRef(0)
  useEffect(() => {
    const request = ++intent.current
    setLoaded(null); setSelected(null); setBusy(false); setError('')
    getOrgPicture(slug).then(r => { if (request === intent.current) setLoaded({ ...r, slug }) }, e => { if (request === intent.current) setError(String(e)) })
    return () => { intent.current++ }
  }, [slug, revision, retry])
  const current = loaded?.slug === slug ? loaded : null
  const choose = async (file: File | undefined) => {
    const request = ++intent.current
    setSelected(null); setError('')
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { setError('Choose an image up to 5 MiB.'); return }
    setBusy(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
      const data = btoa(binary)
      const p = await previewOrgPicture(slug, data)
      if (request !== intent.current) return
      setSelected({ data, src: 'data:image/png;base64,' + p.data, width: p.width, height: p.height })
      setCrop({ x: .5, y: .5, size: 1 })
    } catch (e) { if (request === intent.current) setError(String(e)) }
    finally { if (request === intent.current) setBusy(false) }
  }
  const save = async (remove: boolean) => {
    if (!current) return
    const request = ++intent.current
    setBusy(true); setError('')
    try {
      const picture = await setOrgPicture(slug, current.owner, remove ? null : selected!.data, crop)
      if (request === intent.current) { setLoaded({ ...current, picture }); setSelected(null) }
    } catch (e) { if (request === intent.current) setError(String(e)) }
    finally { if (request === intent.current) setBusy(false) }
  }
  const side = selected ? Math.min(selected.width, selected.height) * crop.size : 1
  return <SetGroup title="Profile picture">
    <SetBlock hint="This organization's picture appears in Hubchat. Static PNG, JPEG or WebP, up to 5 MiB and 16 megapixels.">
      {current?.picture?.data && !selected && <img alt="Organization profile picture" src={'data:image/png;base64,' + current.picture.data} width={80} height={80} style={{ borderRadius: '50%', objectFit: 'cover' }} />}
      <input aria-label="Choose organization profile picture" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || !current} onChange={e => { void choose(e.currentTarget.files?.[0]); e.currentTarget.value = '' }} />
      {selected && <>
        <div aria-label="Square crop preview" style={{ position: 'relative', width: 192, height: 192, overflow: 'hidden', margin: '12px 0' }}>
          <img alt="Selected organization picture crop" src={selected.src} style={{ position: 'absolute', maxWidth: 'none', width: selected.width / side * 192, height: selected.height / side * 192, left: -(selected.width - side) * crop.x / side * 192, top: -(selected.height - side) * crop.y / side * 192 }} />
        </div>
        <label>Crop size<input aria-label="Crop size" type="range" min="0.1" max="1" step="0.01" value={crop.size} disabled={busy} onChange={e => setCrop(c => ({ ...c, size: Number(e.target.value) }))} /></label>
        <label>Horizontal position<input aria-label="Horizontal crop position" type="range" min="0" max="1" step="0.01" value={crop.x} disabled={busy} onChange={e => setCrop(c => ({ ...c, x: Number(e.target.value) }))} /></label>
        <label>Vertical position<input aria-label="Vertical crop position" type="range" min="0" max="1" step="0.01" value={crop.y} disabled={busy} onChange={e => setCrop(c => ({ ...c, y: Number(e.target.value) }))} /></label>
        <button disabled={busy} onClick={() => void save(false)}>Save picture</button>
        <button disabled={busy} onClick={() => { intent.current++; setSelected(null) }}>Cancel crop</button>
      </>}
      {current?.picture?.sha256 && <button disabled={busy} onClick={() => void save(true)}>Remove picture</button>}
      {busy && <div role="status">Processing picture…</div>}
      {error && <div role="alert">{error}{!current && <button onClick={() => setRetry(n => n + 1)}>Retry</button>}</div>}
    </SetBlock>
  </SetGroup>
}
