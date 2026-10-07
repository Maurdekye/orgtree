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
    try { setPhase(await toggleAgentHalt(slug, nid, phase, toast)) }
    finally { setPending(false) }
  }
  return <button className={'halt-control' + (phase === 'halted' ? '' : ' danger')}
    disabled={pending} onClick={act}
    title={phase === 'halted' ? 'Allow pending work to resume'
      : phase === 'halting' ? 'Check that the active turn has fully ended'
      : 'Abruptly end this turn and block every wake until explicit unhalt'}>
    {pending ? 'Please wait…' : phase === 'halted' ? 'Unhalt' : phase === 'halting' ? 'Finish halt' : 'Halt'}
  </button>
}

/** Shared by the desk button and both agent context menus. */
export async function toggleAgentHalt(slug: string, nid: string,
  phase: NonNullable<TreeNode['halt']>['phase'] | undefined,
  toast: ToastFn): Promise<typeof phase> {
  try {
    if (phase === 'halted') {
      const r = await unhaltNode(slug, nid)
      toast([r.unhalted ? `${nid} unhalted; pending work may resume` : r.status ?? 'Already unhalted'])
      return undefined
    }
    const r = await haltNode(slug, nid)
    toast([r.status])
    return r.halted && r.settled ? 'halted' : 'halting'
  } catch (e) {
    toast([`error: ${(e as Error).message}`])
    return phase
  }
}
