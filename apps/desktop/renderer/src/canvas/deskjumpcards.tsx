import type { ReactNode } from 'react'
import { AudienceFold } from './mail'
import { DESK_JUMP_FOLD_LIMIT, useJumpFold } from './shared'

/** Agent and project desks share the preference, threshold and disclosure.
 * A custom remainder keeps retired controls between reports and watchdogs.
 * The superior row keeps its leading superior out of the fold (`keep`): when
 * it folds, only the project levels go behind the button (user 2026-10-20
 * 09:42Z, under the report row's own rule, 09:50Z). */
export function DeskJumpCards({ ids, render, children, keep = 0, label = 'jump cards' }: {
  ids: string[]
  render: (id: string) => ReactNode
  children?: (folded: boolean) => ReactNode
  /** how many leading cards stay out of the fold */
  keep?: number
  /** what the counted button folds, plural */
  label?: string
}) {
  const enabled = useJumpFold()
  const folded = enabled && ids.length > DESK_JUMP_FOLD_LIMIT
  return <>
    {folded && ids.slice(0, keep).map(render)}
    {folded && <AudienceFold label={label} ids={ids.slice(keep)} render={render} limit={DESK_JUMP_FOLD_LIMIT + 1 - keep} />}
    {children ? children(folded) : !folded && ids.map(render)}
  </>
}

/** A superior row's cards that never fold: its agent superior (or the
 *  switchboard), which leads the row; the project levels after it fold. */
export const superiorKept = (up: readonly { kind?: string }[]) => up.length > 0 && up[0]!.kind !== 'project' ? 1 : 0
