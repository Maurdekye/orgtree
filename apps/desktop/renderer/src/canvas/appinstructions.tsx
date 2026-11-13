// App settings > Runtime > Instructions for all orgs (USER 2026-10-31
// m187a259a848d; coordinator rulings mdd81da812d3b 7-9): one block every agent
// in every org receives, right before its own org's org.md. It keeps the org
// charter's editor pattern (Org settings > Basic > Org charter): explicit Save
// with the loaded revision, the same load guards and delivery warning. The
// Connect your phone note is ordinary text here, as in org.md (USER
// 2026-10-31 13:59:20Z md088b15466fa): Connect puts it on top, Unlink takes it out.
import { useEffect, useRef, useState } from 'react'
import { getAppInstructions, putAppInstructions } from '../api'
import type { AppInstructionsPayload, ToastFn } from '../types'
import { SetBlock, SetGroup } from './settingskit'
import { ConflictNotice, conflictSentence, saveConflictOf } from '../saveconflict'
import type { SaveConflict } from '../saveconflict'
import { formatCount, unicodeLength } from './shared'

const HINT = 'Every agent in every organization receives this in its managed system prompt, on every provider, '
  + 'just before its own org’s org.md, as a standing directive from you. It is delivered at session start, so '
  + 'saving restarts every agent’s session, and with it its prompt cache, at its next turn. Keep it short: it '
  + 'sits in each agent’s cached prefix on every lane.'

export function AppInstructionsSetting({ toast }: { toast: ToastFn }) {
  // null = not loaded: the textarea is disabled and Save skips the write. As
  // in the org charter, a failed READ must never arm a destructive write.
  const [text, setText] = useState<string | null>(null)
  const [meta, setMeta] = useState<AppInstructionsPayload | null>(null)
  const [load, setLoad] = useState<'pending' | 'error' | 'ready'>('pending')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  useEffect(() => {
    setText(null)
    setMeta(null)
    setLoad('pending')
    setLoadError(null)
    let current = true
    getAppInstructions().then(r => {
      if (!current) return
      setMeta(r)
      // a cut read is not the stored text: never load it into an editable buffer
      setText(r.read_truncated ? null : r.content)
      setLoad('ready')
    }).catch((e: unknown) => {
      if (!current) return
      setLoadError(e instanceof Error && e.message ? e.message : 'request failed')
      setLoad('error')
    })
    return () => { current = false }
  }, [retry])
  // someone saved a newer text: the notice stands where the Save button was (saveconflict.tsx)
  const [conflict, setConflict] = useState<SaveConflict | null>(null)
  const save = async (anyway = false) => {
    if (flight.current || text == null || (text === meta?.content && !anyway)) return
    const content = text
    flight.current = true
    setBusy(true)
    setSaveError(null)
    try {
      // "Save mine anyway" is a new save, based on the text that is stored now
      const base = anyway ? (await getAppInstructions()).rev : meta?.rev
      const result = await putAppInstructions(content, base)
      setConflict(null)
      setMeta(m => m ? { ...m, content, rev: result.rev ?? m.rev } : m)
      setWarnings(result.warnings ?? [])
      toast(result.warnings?.length ? result.warnings : ['settings saved'])
    } catch (error) {
      const refused = saveConflictOf(error)
      if (refused) { setConflict(refused); return }
      const message = error instanceof Error ? error.message : 'request failed'
      setSaveError(message)
      toast([`error: ${message}`])
    } finally {
      flight.current = false
      setBusy(false)
    }
  }
  /** "Use theirs": the stored text becomes the editor's text. */
  const takeTheirs = async () => {
    try {
      const fresh = await getAppInstructions()
      setMeta(fresh); setText(fresh.read_truncated ? null : fresh.content); setConflict(null)
    } catch (error) { setSaveError(error instanceof Error ? error.message : 'request failed') }
  }
  const delivered = text == null ? 0 : unicodeLength(text)
  const max = meta?.prompt_max
  return (
    <SetGroup title="Instructions for all orgs">
      <SetBlock hint={HINT}>
        {load === 'pending' && (
          <div className="orgmd-status" role="status" aria-live="polite">Loading the instructions for all orgs...</div>
        )}
        {load === 'error' && (
          <div className="orgmd-status" role="alert">
            Unable to load the instructions for all orgs ({loadError ?? 'request failed'}). The editor is disabled
            until they load successfully.
            <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button>
          </div>
        )}
        <textarea className="orgmd-editor" value={text ?? ''} aria-label="Instructions for all orgs"
          disabled={text == null} onChange={e => setText(e.target.value)} />
        {load === 'ready' && text === '' && (
          <div className="orgmd-status">No instructions for all orgs are configured.</div>
        )}
        {text != null && max != null && delivered > max && (
          <div className="orgmd-warn" role="alert">
            ⚠ {formatCount(delivered)} characters — only the
            first {formatCount(max)} characters reach an agent. The last {formatCount(delivered - max)}
            {' '}{delivered - max === 1 ? 'character is' : 'characters are'} delivered to NO agent in any org.
            {' '}The text saves whole; the delivery is what is cut.
          </div>
        )}
        {conflict ? <ConflictNotice sentence={conflictSentence(conflict, () => 'the instructions for all orgs')} busy={busy}
          theirs={[{ label: 'Instructions for all orgs', text: typeof conflict.fields[0]?.stored === 'string' ? conflict.fields[0].stored : '' }]}
          onUseTheirs={() => { void takeTheirs() }} onSaveMine={() => { void save(true) }} onCancel={() => setConflict(null)} />
          : <button type="button" className="primary" aria-label="Save instructions for all orgs"
            disabled={busy || text == null || text === meta?.content} onClick={() => { void save() }}>Save</button>}
        {busy && <div role="status">Saving the instructions for all orgs…</div>}
        {saveError && <div role="alert">Unable to save the instructions for all orgs: {saveError}</div>}
        {warnings.map((warning, i) => <div role="status" key={i}>{warning}</div>)}
      </SetBlock>
    </SetGroup>
  )
}
