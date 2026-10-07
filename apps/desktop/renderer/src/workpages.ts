import type { WorkItem, WorkItemsPayload } from './types'

export type WorkGroup = 'items' | 'backlogged' | 'archived'
export type WorkPageOptions = { query?: string; sort?: string; agent?: string; team?: string; attention?: string }
export interface WorkPage {
  format: 'orgtree.work-page/v1'
  reset?: boolean
  group: WorkGroup
  rows: WorkItem[]
  total: number
  totals: Record<WorkGroup, number>
  matched: Record<WorkGroup, number>
  assigned_count?: number
  counts: WorkItemsPayload['counts']
  next_offset: number | null
  revision: string
  at: string
}
export type WorkPaging = {
  more: boolean; loadingMore: boolean; loaded: number; total: number
  loadMore: () => void
  counts?: WorkItemsPayload['counts']
  setFilter?: (options: WorkPageOptions) => void
}
