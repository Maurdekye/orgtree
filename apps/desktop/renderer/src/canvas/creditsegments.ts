/** Only agents hold credits. Project wrappers are invisible to the bar and
 * its scale; stop at the next agent because its grant already holds its team.
 * Callers retain their existing live/held eligibility rule. */
interface CreditReport {
  kind?: 'project'; state: string; seat?: number; grant?: number
  children?: readonly CreditReport[]; isBearerOf?: string
}
export function creditSegments(reports: readonly CreditReport[],
  include: (node: CreditReport) => boolean = node => node.state !== 'archived',
): {seat:number;grant:number}[] {
  const out: {seat:number;grant:number}[] = []
  const walk = (children: readonly CreditReport[]) => {
    for (const child of children) {
      if (!include(child)) continue
      if (child.kind === 'project') walk(child.children ?? [])
      else out.push({seat:child.seat ?? 0,grant:child.grant ?? 0})
    }
  }
  walk(reports)
  return out
}
