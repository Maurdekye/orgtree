import type { ReactNode } from 'react'
import { AudienceFold } from './mail'
import { DESK_JUMP_FOLD_LIMIT, useJumpFold } from './shared'

/** Agent and project desks share the preference, threshold and disclosure.
 * A custom remainder keeps retired controls between reports and watchdogs. */
export function DeskJumpCards({ ids, render, children }: {
  ids: string[]
  render: (id: string) => ReactNode
  children?: (folded: boolean) => ReactNode
}) {
  const enabled = useJumpFold()
  const folded = enabled && ids.length > DESK_JUMP_FOLD_LIMIT
  return <>
    {folded && <AudienceFold label="jump cards" ids={ids} render={render} limit={DESK_JUMP_FOLD_LIMIT + 1} />}
    {children ? children(folded) : !folded && ids.map(render)}
  </>
}
