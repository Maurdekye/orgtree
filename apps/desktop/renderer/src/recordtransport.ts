import { req } from './api'
import { RecordFeed } from './recordfeed'
import type { FeedAnswer, FeedIO, RecordSnapshot } from './recordfeed'
import type { SelectionRequest, SelectionAnswer } from './recordtreeselection'

export function resolveRecordSelection(slug: string, request: SelectionRequest): Promise<SelectionAnswer> {
  return req<SelectionAnswer>(`/api/orgs/${encodeURIComponent(slug)}/records/selection?args=${encodeURIComponent(JSON.stringify(request))}`)
}

/** HTTP recovery only. The caller routes frames from the existing org socket. */
export function orgRecordFeed<T>(slug: string, io: Pick<FeedIO<T>, 'project' | 'publish' | 'error' | 'identityChanged'>): RecordFeed<T> {
  const base = `/api/orgs/${encodeURIComponent(slug)}`
  return new RecordFeed<T>({ ...io,
    snapshot: () => req<RecordSnapshot>(`${base}/records`),
    catchup: (c, subs) => req<FeedAnswer>(`${base}/changes?after=${c.rev}`
      + `&org_uuid=${encodeURIComponent(c.org_uuid)}&incarnation=${encodeURIComponent(c.incarnation)}`
      + `&subs=${encodeURIComponent(JSON.stringify(subs))}`),
  })
}
