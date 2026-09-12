import { useEffect, useState } from 'react'
import { haltNode, unhaltNode } from '../api'
import type { TreeNode, ToastFn } from '../types'

export function HaltStatus({ halt }: { halt: NonNullable<TreeNode['halt']> }) {
  return <span className="badge halted" role="status" title={halt.phase === 'halting'
    ? 'Turn admission is blocked; the active turn is still ending'
    : 'No turn can run. Mail stays unread until explicit unhalt'}>
    {halt.phase === 'halting' ? 'Halting…' : 'Halted'}
  </span>
}

export function HaltControl({ slug, nid, halt, toast }: {
  slug: string; nid: string; halt?: TreeNode['halt']; toast: ToastFn
}) {
  const [pending, setPending] = useState(false)
  const [phase, setPhase] = useState(halt?.phase)
  useEffect(() => { setPhase(halt?.phase) }, [halt?.phase])
  async function act() {
    setPending(true)
    try {
      if (phase === 'halted') {
        const r = await unhaltNode(slug, nid)
        setPhase(undefined)
        toast([r.unhalted ? `${nid} unhalted; pending work may resume` : r.status ?? 'Already unhalted'])
      } else {
        const r = await haltNode(slug, nid)
        setPhase(r.halted && r.settled ? 'halted' : 'halting')
        toast([r.status])
      }
    } catch (e) { toast([`error: ${(e as Error).message}`]) }
    finally { setPending(false) }
  }
  return <button className="halt-control" disabled={pending} onClick={act}
    title={phase === 'halted' ? 'Allow pending work to resume'
      : phase === 'halting' ? 'Check that the active turn has fully ended'
      : 'Abruptly end this turn and block every wake until explicit unhalt'}>
    {pending ? 'Please wait…' : phase === 'halted' ? 'Unhalt' : phase === 'halting' ? 'Finish halt' : 'Halt'}
  </button>
}
