// canvas/netmentions.tsx — what an @net: or @org: mention wears: its kind and
// the party's picture (USER 2026-10-27 m08fbc691a349 "also net mentions should
// have custom formatting", mc96766993067 "like remote orgs, users, chats,
// etc.", mf8697b8ba8fc "perhaps if they have a profile picture set then use
// that", m82cf84439a0d "maybe give them the hubchat icon if hubchat is
// installed", ma1f33944e69d "otherwise a globe icon").
//
// The kind is the one the hub reports in its roster (org, person, or chat: an
// agent session), the same three Hubchat shows; an address no roster lists has
// an unknown kind. The icon is the party's picture when Orgtree can see one (a
// local org's logo, or the picture a hub this org is registered on advertises),
// else the Hubchat mark when Hubchat is installed, else a globe. The React chip
// and the DOM chip the Markdown walk builds draw the SAME element and share ONE
// tooltip, like every other mention.
import { useEffect, useState } from 'react'
import { getMentionPicture } from '../api'
import type { NetBlock, NetPeer } from '../types'
import { isHubchatInstalled, resolveHubAddressAction } from './agentmentions'
import './netmentions.css'

export type NetKind = 'org' | 'person' | 'chat' | 'unknown'
export type NetIcon = 'picture' | 'hubchat' | 'globe'

export interface NetMention {
  /** the address, lowercased */
  address: string
  kind: NetKind
  /** an org on this PC (Open goes to it rather than to Hubchat) */
  local: boolean
  /** the roster's name for it, when it gives one */
  name: string | null
  icon: NetIcon
  /** the picture as a data URL, when it is the icon */
  picture: string | null
  /** what the shown picture was fetched for (its revision) */
  pictureKey: string | null
}

interface RosterEntry { kind: NetKind; name: string | null; picture: string | null }

/** The org whose views are on screen: its roster, own address and own logo. */
let viewOrg: string | null = null
let ownAddress: string | null = null
let ownPicture: string | null = null
let roster = new Map<string, RosterEntry>()
/** `<org>|<address>` → the picture fetched for what was wanted */
const pictures = new Map<string, { want: string; data: string | null; at: number; failed: boolean }>()
const pending = new Set<string>()
const listeners = new Set<() => void>()
/** a local org's logo has no revision the roster could carry */
const LOCAL_FRESH_MS = 120_000
const RETRY_MS = 60_000
const MAX_PICTURES = 500

function notify() {
  for (const fn of listeners) fn()
}

const kindOf = (kind: NetPeer['kind'] | undefined): NetKind =>
  kind === 'person' ? 'person' : kind === 'chat' ? 'chat' : 'org'

/** Index the on-screen org's hub rosters (tree.net). The newest advertised
 *  picture wins when several hubs list the same address. */
export function setNetRoster(org: string, net: NetBlock | null | undefined): void {
  const next = new Map<string, RosterEntry>()
  for (const hub of net?.hubs ?? []) for (const peer of hub.roster ?? []) {
    if (!peer?.slug) continue
    const address = `@net:${peer.slug.toLowerCase()}`
    const picture = peer.picture?.sha256 ? peer.picture.revision : null
    const seen = next.get(address)
    if (seen && (seen.picture ?? '') >= (picture ?? '')) continue
    next.set(address, { kind: kindOf(peer.kind), name: (peer.org_name || peer.username || '').trim() || null, picture })
  }
  const own = net?.slug ? `@net:${net.slug.toLowerCase()}` : null
  const ownPic = net?.picture_revision ?? null
  if (org === viewOrg && own === ownAddress && ownPic === ownPicture && sameRoster(next, roster)) return
  viewOrg = org
  ownAddress = own
  ownPicture = ownPic
  roster = next
  notify()
}

function sameRoster(a: Map<string, RosterEntry>, b: Map<string, RosterEntry>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    const w = b.get(k)
    if (!w || w.kind !== v.kind || w.name !== v.name || w.picture !== v.picture) return false
  }
  return true
}

/** What picture an address wants: a revision, `local` for another local org's
 *  logo, or null when it has none Orgtree could show. */
function wanted(address: string, local: boolean, row: RosterEntry | undefined): string | null {
  if (address === ownAddress) return ownPicture ? `own:${ownPicture}` : null
  if (local) return 'local'
  return row?.picture ?? null
}

export function netMention(address: string): NetMention {
  const a = address.trim().toLowerCase()
  const local = resolveHubAddressAction(a).kind === 'org'
  const row = a.startsWith('@net:') ? roster.get(a) : undefined
  const kind: NetKind = a.startsWith('@org:') || a === ownAddress ? 'org' : row?.kind ?? 'unknown'
  const want = wanted(a, local, row)
  const have = want !== null && viewOrg ? pictures.get(`${viewOrg}|${a}`) : undefined
  const picture = have?.data ?? null
  const icon: NetIcon = picture ? 'picture' : isHubchatInstalled() ? 'hubchat' : 'globe'
  return { address: a, kind, local, name: row?.name ?? null, icon, picture, pictureKey: picture ? have!.want : null }
}

/** Ask for the picture an address wants, once per revision (a local org's
 *  logo every two minutes); a failure is asked again after a minute. */
export function ensureNetPicture(address: string): void {
  const org = viewOrg
  if (!org) return
  const a = address.trim().toLowerCase()
  const local = resolveHubAddressAction(a).kind === 'org'
  const want = wanted(a, local, a.startsWith('@net:') ? roster.get(a) : undefined)
  if (want === null) return
  const key = `${org}|${a}`
  const have = pictures.get(key)
  const age = have ? Date.now() - have.at : Infinity
  if (have && have.want === want && !(have.failed && age >= RETRY_MS) && !(want === 'local' && age >= LOCAL_FRESH_MS)) return
  if (pending.has(key)) return
  pending.add(key)
  getMentionPicture(org, a).then(r => {
    const data = r?.picture?.data ? `data:image/png;base64,${r.picture.data}` : null
    pictures.set(key, { want, data, at: Date.now(), failed: false })
  }, () => {
    // keep what was shown; ask again later
    pictures.set(key, { want, data: have?.data ?? null, at: Date.now(), failed: true })
  }).finally(() => {
    pending.delete(key)
    if (pictures.size > MAX_PICTURES) pictures.delete(pictures.keys().next().value!)
    notify()
  })
}

const KIND_LABEL: Record<NetKind, string> = {
  org: 'Orgtree org', person: 'Person', chat: 'Agent session', unknown: 'Network address',
}

/** The kind as the tooltip names it. */
export function netKindLabel(info: NetMention): string {
  return KIND_LABEL[info.kind]
}

/** THE tooltip of every link to a network address: what it is, then what a
 *  click does. An org on this PC keeps the org identity's own hover, which
 *  its rows and links share everywhere (orgidentity.ts). */
export function hubAddressTitle(address: string): string {
  const info = netMention(address)
  const action = resolveHubAddressAction(info.address).title
  if (info.local) return action
  return `${netKindLabel(info)}${info.name ? `: ${info.name}` : ''}\n${action}`
}

/** The chip's classes after `ref-chip ref-hub`. */
export function netChipClass(info: NetMention): string {
  return `net-chip net-${info.kind}${info.local ? ' net-local' : ''}`
}

/** What the Markdown walk compares before rebuilding a chip. */
export function netChipSig(info: NetMention): string {
  return [info.kind, info.local ? 1 : 0, info.icon, info.pictureKey ?? ''].join(':')
}

export function useNetMentionState(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const fn = () => setTick(n => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
  return tick
}

// The globe: MUI's Language icon.
const GLOBE = 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2m6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56M12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96M4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56m2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8M12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96M14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2m.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56M16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2z'
// The Hubchat mark (orgtree-hubchat public/hubchat.svg without its tile, which
// the mark's own background draws so its shape can follow the kind):
// Orgtree's almond eye turned into a speech bubble.
const HUBCHAT_BUBBLE = 'M10 120C39 70 82 40 128 40s89 30 118 80c-29 50-72 80-118 80-17 0-33-4-48-11L30 222l16-46C32 160 20 141 10 120Z'

const SVG = 'http://www.w3.org/2000/svg'

/** The icon as DOM, for chips built outside React. Never parses markup. */
export function createNetMarkEl(doc: Document, info: NetMention): HTMLElement {
  const span = doc.createElement('span')
  span.className = `net-mark net-mark-${info.icon}`
  span.setAttribute('aria-hidden', 'true')
  if (info.icon === 'picture') {
    const img = doc.createElement('img')
    img.src = info.picture!
    img.alt = ''
    img.draggable = false
    span.appendChild(img)
    return span
  }
  const svg = doc.createElementNS(SVG, 'svg')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('aria-hidden', 'true')
  if (info.icon === 'globe') {
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'currentColor')
    const path = doc.createElementNS(SVG, 'path')
    path.setAttribute('d', GLOBE)
    svg.appendChild(path)
  } else {
    svg.setAttribute('viewBox', '0 0 256 256')
    const g = doc.createElementNS(SVG, 'g')
    g.setAttribute('transform', 'translate(28 34) scale(.78)')
    const bubble = doc.createElementNS(SVG, 'path')
    bubble.setAttribute('fill', '#d97757')
    bubble.setAttribute('d', HUBCHAT_BUBBLE)
    const pupil = doc.createElementNS(SVG, 'circle')
    for (const [k, v] of Object.entries({ cx: '128', cy: '120', r: '54', fill: '#17191d' })) pupil.setAttribute(k, v)
    const iris = doc.createElementNS(SVG, 'circle')
    for (const [k, v] of Object.entries({ cx: '128', cy: '120', r: '23', fill: '#d97757' })) iris.setAttribute(k, v)
    g.append(bubble, pupil, iris)
    svg.appendChild(g)
  }
  span.appendChild(svg)
  return span
}

/** The same icon in React. */
export function NetMark({ info }: { info: NetMention }) {
  return (
    <span className={`net-mark net-mark-${info.icon}`} aria-hidden="true">
      {info.icon === 'picture'
        ? <img src={info.picture!} alt="" draggable={false} />
        : info.icon === 'globe'
          ? <svg focusable="false" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d={GLOBE} /></svg>
          : <svg focusable="false" aria-hidden="true" viewBox="0 0 256 256">
            <g transform="translate(28 34) scale(.78)">
              <path fill="#d97757" d={HUBCHAT_BUBBLE} />
              <circle cx="128" cy="120" r="54" fill="#17191d" />
              <circle cx="128" cy="120" r="23" fill="#d97757" />
            </g>
          </svg>}
    </span>
  )
}

/** The address with its scheme set apart (`@net:` / `@org:`): the text stays
 *  exactly what was written. */
export function splitScheme(token: string): [string, string] {
  const i = token.indexOf(':')
  return i < 0 ? ['', token] : [token.slice(0, i + 1), token.slice(i + 1)]
}

/** Test seam: forget the roster, pictures and listeners' state. */
export function resetNetMentions(): void {
  viewOrg = null
  ownAddress = null
  ownPicture = null
  roster = new Map()
  pictures.clear()
  pending.clear()
  notify()
}
