// canvas/remotefiles.tsx — the Files panel: a scratch folder of a remote organization, a
// folder at a time, with Download, Download as zip and Upload (remotefiles.ts has what it
// asks and knows; docs/rust-engine/remote-org.md, "The Files panel").
//
// It is opened by the scratch-folder entries of a remote window (scratch-folder.ts) and mounted
// once per window (App.tsx). A local organization never sees it: its entries open the file
// manager.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { ToastFn } from '../types'
import { DownloadIcon, FileIcon, FolderIcon } from '../icons'
import { remoteFolderText, useRemoteHere } from '../remotehere'
import { ProviderDialog } from './providerdialog'
import {
  LARGE, UPLOAD_MAX, closeRemoteFiles, crumbs, dismissTransfer, downloadUrl, joinPath, keptBeside, listFiles, olderEngine,
  progressText, sizeText, uploadFile, useRemoteFilesTarget, useTransfers, watchDownloads,
} from '../remotefiles'
import type { Conflict, FileEntry, FilesTarget, Transfer } from '../remotefiles'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

const when = (modified: number | null): string => modified === null ? '' : new Date(modified).toLocaleString(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
})

/** A file waiting for the user's word before it is sent: one of the same name is there, or it
 *  is large enough to say so first. */
interface Asked { file: File; exists: boolean; large: boolean }

function TransferRow({ transfer }: { transfer: Transfer }) {
  const words = transfer.state === 'running' ? progressText(transfer.done, transfer.total)
    : transfer.state === 'done' ? `Done, ${sizeText(transfer.done)}`
      : transfer.error ?? (transfer.state === 'stopped' ? 'Stopped.' : 'Failed.')
  const share = transfer.total ? Math.min(1, transfer.done / transfer.total) : null
  return <li className={`remote-files-transfer remote-files-transfer-${transfer.state}`} data-transfer={transfer.kind}>
    <span className="remote-files-transfer-name">{transfer.kind === 'upload' ? 'Upload' : 'Download'}: {transfer.name}</span>
    <span className="remote-files-transfer-words" role={transfer.state === 'failed' ? 'alert' : 'status'}>{words}</span>
    {transfer.state === 'running' && <progress aria-label={`${transfer.name}: ${words}`} {...(share === null ? {} : { value: share, max: 1 })} />}
    {transfer.state === 'running'
      ? transfer.stop && <button type="button" onClick={transfer.stop}>Cancel</button>
      : <button type="button" onClick={() => dismissTransfer(transfer.id)} aria-label={`Dismiss ${transfer.name}`}>Dismiss</button>}
  </li>
}

function Panel({ target, toast }: { target: FilesTarget; toast: ToastFn }) {
  const remote = useRemoteHere()
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[] | null>(null)
  const [next, setNext] = useState<number | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [asked, setAsked] = useState<Asked[]>([])
  const [forAll, setForAll] = useState(false)
  const transfers = useTransfers()
  const picker = useRef<HTMLInputElement>(null)
  const serial = useRef(0)
  const where = remote?.name ?? 'the other computer'

  const load = useCallback(async (folder: string, offset = 0) => {
    const at = ++serial.current
    setBusy(true); setError(null)
    try {
      const page = await listFiles(target, folder, offset)
      if (at !== serial.current) return
      setEntries((before) => offset && before ? [...before, ...page.entries] : page.entries)
      setNext(page.next); setTotal(page.total)
    } catch (e) {
      if (at !== serial.current) return
      if (olderEngine(e)) {
        // an engine older than the Files routes: what the entry said before there was a panel
        toast([`${remoteFolderText(where)} Its Orgtree is older than 4.6.0, which is what shows a folder here.`])
        closeRemoteFiles()
        return
      }
      if (!offset) setEntries(null)
      setError(message(e))
    } finally { if (at === serial.current) setBusy(false) }
  }, [target, toast, where])

  useEffect(() => { void load(path) }, [load, path])
  useEffect(() => watchDownloads(), [])

  const open = (folder: string) => { setEntries(null); setAsked([]); setPath(folder) }

  const send = useCallback(async (file: File, conflict: Conflict) => {
    try {
      const done = await uploadFile(target, path, file, conflict)
      toast([`${done.name} is in ${path || target.title} on ${where}`])
      void load(path)
    } catch (e) {
      const status = (e as { status?: unknown }).status
      // somebody put a file of that name there since the folder was listed: ask
      if (status === 409 && conflict === 'ask') setAsked((before) => [...before, { file, exists: true, large: false }])
    }
  }, [target, path, toast, where, load])

  const chosen = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    const names = new Set((entries ?? []).map((entry) => entry.name))
    const ask: Asked[] = []
    for (const file of files) {
      const exists = names.has(file.name), large = file.size >= LARGE && file.size <= UPLOAD_MAX
      if (exists || large) ask.push({ file, exists, large })
      else void send(file, 'ask')
    }
    setForAll(false)
    setAsked((before) => [...before, ...ask])
  }

  const answer = (choice: Conflict | 'skip') => {
    const [first, ...rest] = asked
    if (!first) return
    // "for all" is about the files of the same question: those that are there already
    const same = forAll && first.exists ? rest.filter((a) => a.exists) : []
    setAsked(rest.filter((a) => !same.includes(a)))
    setForAll(false)
    if (choice !== 'skip') for (const a of [first, ...same]) void send(a.file, a.exists ? choice : 'ask')
  }

  const first = asked[0]
  const taken = new Set((entries ?? []).map((entry) => entry.name))
  const trail = crumbs(path)
  return (
    <ProviderDialog title={`Files: ${target.title}`} busy={false} close={closeRemoteFiles}>
      <div className="ls-add remote-files" role="group" aria-label={`Files of ${target.title}`}>
        <p className="dim remote-files-where">This folder is on {where}. Nothing here opens on this computer until you download it.</p>
        <nav className="remote-files-trail" aria-label="Folder">
          <button type="button" disabled={!path} onClick={() => open('')}><FolderIcon fontSize="inherit" /> {target.title}</button>
          {trail.map((crumb, i) => <span key={crumb.path}>
            <span aria-hidden="true"> / </span>
            <button type="button" disabled={i === trail.length - 1} onClick={() => open(crumb.path)}>{crumb.name}</button>
          </span>)}
        </nav>
        <div className="remote-files-tools">
          <button type="button" onClick={() => picker.current?.click()} disabled={entries === null}>Upload files...</button>
          <input ref={picker} type="file" multiple hidden aria-label="Files to upload" onChange={chosen} />
          <a className="remote-files-zip" href={downloadUrl(target, path)} download={`${trail[trail.length - 1]?.name ?? target.title}.zip`}
            aria-disabled={entries === null || undefined} title="Everything in this folder, as one zip file">
            <DownloadIcon fontSize="inherit" /> Download this folder as zip
          </a>
          <button type="button" onClick={() => { void load(path) }} disabled={busy}>Refresh</button>
        </div>
        {first && <div className="remote-files-ask ask-warn" role="alertdialog" aria-label={`About ${first.file.name}`}>
          <p>
            {first.exists
              ? <><strong>{first.file.name}</strong> is already in this folder{first.large ? `, and the new one is ${sizeText(first.file.size)}` : ''}.</>
              : <><strong>{first.file.name}</strong> is {sizeText(first.file.size)}. Upload it?</>}
          </p>
          <div className="ls-actions">
            {first.exists ? <>
              <button type="button" onClick={() => answer('replace')}>Replace</button>
              <button type="button" onClick={() => answer('keep_both')} title={`The new one becomes ${keptBeside(first.file.name, taken)}`}>Keep both</button>
            </> : <button type="button" onClick={() => answer('ask')}>Upload</button>}
            <button type="button" className="acct-secondary-btn" onClick={() => answer('skip')}>Skip</button>
            {first.exists && asked.filter((a) => a.exists).length > 1 && <label className="remote-files-all">
              <input type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)} /> Do this for all {asked.filter((a) => a.exists).length}
            </label>}
          </div>
        </div>}
        {error && <p className="ask-warn" role="alert">{error}</p>}
        {entries === null && !error && <p className="dim" role="status">Reading the folder...</p>}
        {entries && entries.length === 0 && <p className="dim">This folder is empty.</p>}
        {entries && entries.length > 0 && <ul className="remote-files-list" aria-label={`${total} ${total === 1 ? 'entry' : 'entries'}`}>
          {entries.map((entry) => <li key={entry.name} className={`remote-files-entry remote-files-${entry.kind}`}>
            {entry.kind === 'folder'
              ? <button type="button" className="remote-files-name" onClick={() => open(joinPath(path, entry.name))}><FolderIcon fontSize="inherit" /> {entry.name}</button>
              : <span className="remote-files-name"><FileIcon fontSize="inherit" /> {entry.name}</span>}
            <span className="remote-files-size dim">{entry.kind === 'file' && entry.bytes !== null ? sizeText(entry.bytes) : entry.kind === 'link' ? 'link' : ''}</span>
            <span className="remote-files-when dim">{when(entry.modified)}</span>
            {entry.kind === 'link'
              ? <span className="dim remote-files-act" title="A link to somewhere else is not followed">not followed</span>
              : <a className="remote-files-act" href={downloadUrl(target, joinPath(path, entry.name))}
                download={entry.kind === 'folder' ? `${entry.name}.zip` : entry.name}
                aria-label={entry.kind === 'folder' ? `Download ${entry.name} as zip` : `Download ${entry.name}`}>
                <DownloadIcon fontSize="inherit" /> {entry.kind === 'folder' ? 'Zip' : 'Download'}
              </a>}
          </li>)}
        </ul>}
        {next !== null && entries && <button type="button" disabled={busy} onClick={() => { void load(path, next) }}>
          Show more ({entries.length} of {total})
        </button>}
        {transfers.length > 0 && <ul className="remote-files-transfers" aria-label="Transfers">
          {transfers.map((transfer) => <TransferRow key={transfer.id} transfer={transfer} />)}
        </ul>}
        <div className="ls-actions">
          <button type="button" className="acct-secondary-btn" onClick={closeRemoteFiles}>Done</button>
        </div>
      </div>
    </ProviderDialog>
  )
}

/** Mounted once per window: shows the panel while a scratch folder is open in it. */
export function RemoteFilesPanel({ toast }: { toast: ToastFn }) {
  const target = useRemoteFilesTarget()
  return target ? <Panel key={`${target.org}/${target.scope ?? ''}/${target.node}`} target={target} toast={toast} /> : null
}
