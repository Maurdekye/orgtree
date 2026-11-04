/* stallhook.ts - imported before React (main.tsx) so the stall tooling's React-commit hook exists when react-dom loads.
   Idle unless the desktop bridge takes stall records and the tooling was not switched off (ORGTREE_STALLWATCH=0). */
import { installReactHook } from './stallwatch'

const bridge = (window as unknown as { orgtreeDesktop?: { diagStall?: unknown; stallwatch?: boolean } }).orgtreeDesktop
if (bridge && typeof bridge.diagStall === 'function' && bridge.stallwatch !== false) installReactHook()
