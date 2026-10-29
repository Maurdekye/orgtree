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
// else a globe. With Hubchat installed it is Hubchat's DM-list avatar at text
// size instead (USER 2026-10-29 m019c9500d23a "A2 use the lettering on the
// colored background as the icon instead of the hubchat icon when hubchat is
// connected for both"; the derivation agreed with @hubchat-design-opus, whose
// Hubchat mention mark is the same avatar): the picture; an agent session's
// terminal icon, never a picture; else the initials (Hubchat's format.initials
// over the roster name, else the address) on the kind's tint, the org's own
// address on the own-avatar tint; and a grey dot for an address no roster
// lists. The React chip and the DOM chip the Markdown walk builds draw the
// SAME element and share ONE tooltip, like every other mention.
//
// A party the roster names shows that name (USER 2026-10-27 mb7ea64d82743 "Show
// the name", told of the impersonation risk). The chip's TEXT stays the address
// token, so a copy, Reply to selection and the written mention all keep the
// address; the name is drawn from data-net-name, and the hover gives the
// address. The icon and the kind's tinted, outlined pill mark the outside party
// (USER 2026-10-27 m442b6dcaab52 "their link will be distinguished by the icon").
//
// The hover of an address a hub lists leads with its presence and its type
// (USER 2026-10-29 m6f8fcfbd2824 "and just show that text when hovering the
// link", m822daec481cc "online status and chat type", me07459d92f6d "(org,
// person, independent chat)"): "Online · independent chat", then the hub's
// description of it, when it has one. That is the text the Connections rows
// used to show beside each chip (canvas/connectionlist.tsx).
import { useEffect, useState } from 'react'
import { getMentionPicture } from '../api'
import type { NetBlock, NetPeer } from '../types'
import { isHubchatInstalled, resolveHubAddressAction } from './agentmentions'
import './netmentions.css'

export type NetKind = 'org' | 'person' | 'chat' | 'unknown'
export type NetIcon = 'picture' | 'letters' | 'terminal' | 'dot' | 'globe'
/** The avatar's tint, as Hubchat's kinds and its own avatar (tokens.css --k-*). */
export type NetAvatar = 'org' | 'person' | 'chat' | 'me'

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
  /** the tint of a `letters` or `terminal` mark */
  avatar: NetAvatar | null
  /** the letters a `letters` mark draws */
  initials: string | null
  /** the presence a hub lists for it: online on any hub that lists it; null
   *  when no roster lists it */
  online: boolean | null
  /** the hub's description of it (its blurb), when it gives one */
  about: string | null
}

interface RosterEntry { kind: NetKind; name: string | null; picture: string | null; online: boolean; about: string | null }

/** The org whose views are on screen: its roster, own address and own logo. */
let viewOrg: string | null = null
let ownAddress: string | null = null
let ownPicture: string | null = null
let roster = new Map<string, RosterEntry>()
/** this computer's hub as App settings → Mail hub read it (setLocalHubRoster) */
let localHub = new Map<string, RosterEntry>()
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

/** A hub description longer than this is cut in the hover. */
const ABOUT_MAX = 200

/** Index roster rows by address. The newest advertised picture wins when
 *  several hubs list the same address; it is online when any of them says so,
 *  and keeps the first description given. */
function indexRoster(peers: Iterable<NetPeer>): Map<string, RosterEntry> {
  const next = new Map<string, RosterEntry>()
  for (const peer of peers) {
    if (!peer?.slug) continue
    const address = `@net:${peer.slug.toLowerCase()}`
    const picture = peer.picture?.sha256 ? peer.picture.revision : null
    const text = (peer.blurb ?? '').trim()
    const about = !text ? null : text.length > ABOUT_MAX ? text.slice(0, ABOUT_MAX - 1).trimEnd() + '…' : text
    const seen = next.get(address)
    const online = !!peer.online || !!seen?.online
    if (seen && (seen.picture ?? '') >= (picture ?? '')) {
      next.set(address, { ...seen, online, about: seen.about ?? about })
      continue
    }
    next.set(address, { kind: kindOf(peer.kind), name: (peer.org_name || peer.username || '').trim() || null, picture,
      online, about: about ?? seen?.about ?? null })
  }
  return next
}

/** Index the on-screen org's hub rosters (tree.net). */
export function setNetRoster(org: string, net: NetBlock | null | undefined): void {
  const next = indexRoster((net?.hubs ?? []).flatMap(hub => hub.roster ?? []))
  const own = net?.slug ? `@net:${net.slug.toLowerCase()}` : null
  const ownPic = net?.picture_revision ?? null
  if (org === viewOrg && own === ownAddress && ownPic === ownPicture && sameRoster(next, roster)) return
  viewOrg = org
  ownAddress = own
  ownPicture = ownPic
  roster = next
  notify()
}

/** Every address registered on this computer's hub, as App settings → Mail
 *  hub read them (USER 2026-10-29 m12a433749fda), while that list is shown;
 *  null when it closes. Its chips are described from these rows where the
 *  on-screen org's rosters, which stay first, do not list the address: App
 *  settings opened from Home has no org on screen at all. */
export function setLocalHubRoster(peers: readonly NetPeer[] | null): void {
  const next = indexRoster(peers ?? [])
  if (sameRoster(next, localHub)) return
  localHub = next
  notify()
}

/** An address's roster row: the on-screen org's rosters first, then this computer's hub. */
const listed = (address: string): RosterEntry | undefined => roster.get(address) ?? localHub.get(address)

/** The presence the hubs list for an `@net:` address, or null when none lists it. */
export function netPresence(address: string): boolean | null {
  return listed(address.trim().toLowerCase())?.online ?? null
}

/** The on-screen org's own address (`@net:<slug>`), or null before its network block arrives or when it has none. */
export function orgNetAddress(): string | null {
  return ownAddress
}

function sameRoster(a: Map<string, RosterEntry>, b: Map<string, RosterEntry>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) {
    const w = b.get(k)
    if (!w || w.kind !== v.kind || w.name !== v.name || w.picture !== v.picture || w.online !== v.online || w.about !== v.about) return false
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

/** Hubchat's initials (src/lib/format.ts initials), verbatim: the first
 *  letter of the first word and of the last, upper case. */
export function netInitials(name: string): string {
  const w = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/)
  const first = w[0] || '?', last = w.length > 1 ? w[w.length - 1] ?? '' : ''
  return ((first[0] ?? '?') + (last[0] ?? '')).toUpperCase()
}

export function netMention(address: string): NetMention {
  const a = address.trim().toLowerCase()
  const local = resolveHubAddressAction(a).kind === 'org'
  const row = a.startsWith('@net:') ? listed(a) : undefined
  const kind: NetKind = a.startsWith('@org:') || a === ownAddress ? 'org' : row?.kind ?? 'unknown'
  const want = wanted(a, local, row)
  const have = want !== null && viewOrg ? pictures.get(`${viewOrg}|${a}`) : undefined
  const picture = have?.data ?? null
  const icon: NetIcon = !isHubchatInstalled() ? (picture ? 'picture' : 'globe')
    : kind === 'chat' ? 'terminal'
      : picture ? 'picture'
        : kind === 'unknown' && !local ? 'dot' : 'letters'
  const avatar: NetAvatar | null = icon === 'terminal' ? 'chat'
    : icon !== 'letters' ? null
      : a === ownAddress ? 'me' : kind === 'person' ? 'person' : 'org'
  const name = row?.name ?? null
  return { address: a, kind, local, name, icon, picture, pictureKey: picture ? have!.want : null,
    avatar, initials: icon === 'letters' ? netInitials(name || splitScheme(a)[1]) : null,
    online: row ? row.online : null, about: row?.about ?? null }
}

/** Ask for the picture an address wants, once per revision (a local org's
 *  logo every two minutes); a failure is asked again after a minute. */
export function ensureNetPicture(address: string): void {
  const org = viewOrg
  if (!org) return
  const a = address.trim().toLowerCase()
  const local = resolveHubAddressAction(a).kind === 'org'
  const want = wanted(a, local, a.startsWith('@net:') ? listed(a) : undefined)
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

/** A listed address's type, in the user's words (USER 2026-10-29
 *  me07459d92f6d "(org, person, independent chat)"). */
const TYPE_WORD: Record<NetKind, string> = {
  org: 'org', person: 'person', chat: 'independent chat', unknown: 'network address',
}

/** "Online · independent chat": the presence and type of an address a hub
 *  lists (USER m822daec481cc "online status and chat type"); null when none
 *  lists it. */
export function netStatusLine(info: NetMention): string | null {
  return info.online === null ? null : `${info.online ? 'Online' : 'Offline'} · ${TYPE_WORD[info.kind]}`
}

/** THE tooltip of every link to a network address: what it is, then what a
 *  click does. An address a hub lists leads with its presence and type, then
 *  its name, the hub's description of it and its address; any other leads
 *  with its kind. An org on this PC keeps the org identity's own hover, which
 *  its rows and links share everywhere (orgidentity.ts). */
export function hubAddressTitle(address: string): string {
  const info = netMention(address)
  const action = resolveHubAddressAction(info.address).title
  if (info.local) return action
  const name = shownName(info)
  const status = netStatusLine(info)
  if (status) return [status, name, info.about, name ? info.address : null, action].filter(Boolean).join('\n')
  return name ? `${netKindLabel(info)}: ${name}\n${info.address}\n${action}` : `${netKindLabel(info)}\n${action}`
}

/** The name a chip shows instead of its address: the roster's, for a party
 *  outside this PC. A local org keeps its address, as its org rows do. */
export function shownName(info: NetMention): string | null {
  return info.local ? null : info.name
}

/** A named chip's accessible name: the name, then the address it stands for. */
export function netChipLabel(info: NetMention): string | undefined {
  const name = shownName(info)
  return name ? `${name} (${info.address})` : undefined
}

/** The chip's classes after `ref-chip ref-hub`. */
export function netChipClass(info: NetMention): string {
  return `net-chip net-${info.kind}${info.local ? ' net-local' : ''}${shownName(info) ? ' net-named' : ''}`
}

/** What the Markdown walk compares before rebuilding a chip. */
export function netChipSig(info: NetMention): string {
  return [info.kind, info.local ? 1 : 0, info.icon, info.pictureKey ?? '', shownName(info) ?? '',
    info.avatar ?? '', info.initials ?? ''].join(':')
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
// An agent session's avatar: MUI's Terminal icon, the path Hubchat's own
// terminal icon draws (src/lib/icons.tsx).
const TERMINAL = 'M20 4H4c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2m0 14H4V8h16zm-2-1h-6v-2h6zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4z'

const SVG = 'http://www.w3.org/2000/svg'

/** The mark's classes: its icon, and the avatar's tint. The letters are drawn
 *  by CSS from data-initials, so the chip's text, and every copy, stays the
 *  address; like every letter in a tile they are a .letter-chip (72909f0). */
const netMarkClass = (info: NetMention) => `net-mark net-mark-${info.icon}${info.icon === 'letters' ? ' letter-chip' : ''}`
  + (info.avatar ? ` net-av-${info.avatar}` : '')

/** The icon as DOM, for chips built outside React. Never parses markup. */
export function createNetMarkEl(doc: Document, info: NetMention): HTMLElement {
  const span = doc.createElement('span')
  span.className = netMarkClass(info)
  span.setAttribute('aria-hidden', 'true')
  if (info.icon === 'letters') span.setAttribute('data-initials', info.initials ?? '')
  if (info.icon === 'picture') {
    const img = doc.createElement('img')
    img.src = info.picture!
    img.alt = ''
    img.draggable = false
    span.appendChild(img)
    return span
  }
  if (info.icon === 'globe' || info.icon === 'terminal') {
    const svg = doc.createElementNS(SVG, 'svg')
    svg.setAttribute('focusable', 'false')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'currentColor')
    const path = doc.createElementNS(SVG, 'path')
    path.setAttribute('d', info.icon === 'globe' ? GLOBE : TERMINAL)
    svg.appendChild(path)
    span.appendChild(svg)
  }
  return span
}

/** The same icon in React. */
export function NetMark({ info }: { info: NetMention }) {
  return (
    <span className={netMarkClass(info)} aria-hidden="true"
      data-initials={info.icon === 'letters' ? info.initials ?? '' : undefined}>
      {info.icon === 'picture'
        ? <img src={info.picture!} alt="" draggable={false} />
        : info.icon === 'globe' || info.icon === 'terminal'
          ? <svg focusable="false" aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
            <path d={info.icon === 'globe' ? GLOBE : TERMINAL} /></svg>
          : null}
    </span>
  )
}

/** A named chip's name, as DOM. CSS draws it from the attribute, so the chip's
 *  text, and every copy of it, stays the address. */
export function createNetNameEls(doc: Document, info: NetMention): HTMLElement[] {
  const name = shownName(info)
  if (!name) return []
  const shown = doc.createElement('span')
  shown.className = 'net-name'
  shown.setAttribute('data-net-name', name)
  shown.setAttribute('aria-hidden', 'true')
  return [shown]
}

/** The same in React. */
export function NetName({ info }: { info: NetMention }) {
  const name = shownName(info)
  return name ? <span className="net-name" data-net-name={name} aria-hidden="true" /> : null
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
  localHub = new Map()
  pictures.clear()
  pending.clear()
  notify()
}
