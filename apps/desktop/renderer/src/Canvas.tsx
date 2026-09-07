// Canvas.tsx — the barrel over the phase-3 canvas split. The former ~4300-line
// monolith now lives in ./canvas/*: shared (view types + geometry + md),
// cards (UserNode/DraftNode/NodeSquare + switchboard), desk (DeskChat + the
// transcript renderers), mail (MailList/MailFolders/inbox views), modals
// (Confirm/UserConfig/DraftScope/NodeConfig/PilePicker), and OrgCanvas (the
// canvas core). Everything the rest of the app imported from this file
// re-exports here unchanged.

export { useEsc } from './canvas/shared'
export type {
  ActivityInfo, CanvasNode, CanvasScope, MailEvent, MailLinkFn, MailRow,
  OpFn, PulseEvent, StreamEvent,
} from './canvas/shared'
export { ConfirmModal } from './canvas/modals'
export type { ConfirmModalProps } from './canvas/modals'
export { AudienceFold, MailFolders, MailList, OrgRecord, RetiredFold } from './canvas/mail'
export type {
  MailFoldersProps, MailListProps, OrgRecordProps,
} from './canvas/mail'
export { OrgCanvas } from './canvas/OrgCanvas'
export type { OrgCanvasProps } from './canvas/OrgCanvas'
