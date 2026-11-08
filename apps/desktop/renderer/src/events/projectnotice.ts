import type { Event } from '../generated/events'

export type ProjectOp = 'created' | 'retired' | 'dissolved' | 'permanently deleted' | 'restored'
export interface ProjectNotice { project: string; op: ProjectOp; by: string; nodes: number | null }
export const PROJECT_TITLES: Record<ProjectOp, string> = {
  created: 'Project created', retired: 'Project retired', dissolved: 'Project dissolved',
  'permanently deleted': 'Project deleted', restored: 'Project restored',
}

/** The engine's exact stored wording, pinned by projectnotice.test.tsx. */
export function projectLifecycleNotice(body: string): ProjectNotice | null {
  const text = body.replace(/\r?\n$/, '')
  const match = /^Project "([^"\n]+)" was (created|retired|dissolved|permanently deleted|restored) by (the user|"([^"\n]+)")\.(?: Its whole subtree was retired \((\d+) node\(s\)\)\.)?$/.exec(text)
  if (!match || match[0] !== text) return null
  const [, project, op, actor, name, count] = match
  if ((op === 'dissolved') !== (count !== undefined)) return null
  const nodes = count === undefined ? null : Number(count)
  if (count !== undefined && (!/^[1-9]\d*$/.test(count) || !Number.isSafeInteger(nodes))) return null
  return { project, op: op as ProjectOp, by: actor === 'the user' ? 'user' : name, nodes }
}

/** Envelope SYSTEM or explicit engine authorship, never matching agent prose. */
export function projectNotice(event: Event, from?: string): ProjectNotice | null {
  return event.variant === 'ordinary.notice' && (event.engine_authored || from === '@system')
    ? projectLifecycleNotice(event.body) : null
}
