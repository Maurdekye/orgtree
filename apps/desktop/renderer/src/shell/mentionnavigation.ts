import { req } from '../api'

export interface MentionDestination {
  kind: 'agent' | 'mail' | 'work'
  node?: string; generation?: number; mention_id?: string; event_id?: string
  id?: string; to?: string; item?: string; rev?: number
}
export interface NavigationMention {
  id: string; at: string; cursor: string; target: MentionDestination; blurb: string
}
export interface MentionPage { latest_id: string | null; mention: NavigationMention | null }

export function readMention(org: string, before?: string, latest?: string): Promise<MentionPage> {
  const query = new URLSearchParams()
  if (before) query.set('before', before)
  if (latest) query.set('latest', latest)
  return req(`/api/orgs/${encodeURIComponent(org)}/mention-navigation?${query}`)
}

/** Serialize separate presses; org changes invalidate both queued and in-flight
 * work. The server resets the cursor when its newest recorded identity changes. */
export class MentionNavigator {
  private org: string | null = null
  private epoch = 0
  private before?: string
  private latest?: string
  private serial: Promise<void> = Promise.resolve()
  constructor(private read: typeof readMention,
    private open: (org: string, mention: NavigationMention) => void,
    private toast: (message: string) => void) {}
  activate(org: string | null): void {
    if (org === this.org) return
    this.org = org; ++this.epoch; this.before = this.latest = undefined
  }
  go(): Promise<void> {
    const org = this.org, epoch = this.epoch
    if (!org) return Promise.resolve()
    this.serial = this.serial.then(async () => {
      if (epoch !== this.epoch) return
      const page = await this.read(org, this.before, this.latest)
      if (epoch !== this.epoch) return
      if (!page.mention) {
        this.toast(page.latest_id ? 'No older @user mentions' : 'No @user mentions yet')
        return
      }
      this.before = page.mention.cursor; this.latest = page.latest_id ?? undefined
      this.open(org, page.mention)
    }).catch(() => { if (epoch === this.epoch) this.toast('Could not load @user mentions') })
    return this.serial
  }
}
