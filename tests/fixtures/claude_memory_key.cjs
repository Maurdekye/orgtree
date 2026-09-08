// Verbatim key functions extracted from the installed Claude Code 2.1.241
// binary (claude.exe): $ft (string hash), mNr/kLu (sanitize + 200-char
// truncation with base36 hash suffix). Used as the actual-reader control for
// engine/backend/orgtree/desktop_native_claude_memory.project_key.
// Usage: node claude_memory_key.cjs <path> [<path> ...]  -> one key per line.
function $ft(e){let t=0;for(let r=0;r<e.length;r++)t=(t<<5)-t+e.charCodeAt(r)|0;return t}
const TLu=200
function kLu(e){let t=e.replace(/[^a-zA-Z0-9]/g,"-");if(t.length<=TLu)return t;return`${t.slice(0,TLu)}-${Math.abs($ft(e)).toString(36)}`}
for (const arg of process.argv.slice(2)) process.stdout.write(kLu(arg) + "\n")
