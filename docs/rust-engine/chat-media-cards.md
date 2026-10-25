# In-chat media cards

USER 2026-10-25 21:45:44Z approved the proposed defaults for 4.5.0
(m50c447216390, relayed through the coordinator; implementation GO m04eef5bbee29).

Video and audio attachments and delivered files use one shared card in every
chat transcript placement: desk, floating/pinned chat and pop-out. Existing
images retain their inline thumbnail, lightbox and download behavior. Composer
staging and the separate Files list keep their compact previews/rows.

Video/audio do not request bytes before **Play video** or **Play audio**.
Playing enables Chromium's ordinary controls. Video fits the card width and
stays at most 320 px high; audio uses one control row. Playback releases its
source when the card scrolls offscreen, its document hides, it unmounts or its
file/chat/org identity changes. It never resumes automatically on return.
Controls own their normal clicks and keyboard input; middle-button canvas pan
keeps its existing behavior.

The playback ceiling is 256 MiB (268,435,456 bytes), enforced on the opened file
by the engine even when displayed size metadata is missing or outdated. Larger
files remain downloadable. MP4/WebM video and MP3/WAV/Ogg/M4A/AAC/FLAC audio are
offered where Chromium supports them. Container support does not promise every
codec. Unsupported, missing, changed or corrupt media keeps the filename, size
and Download fallback. There is no transcoding or codec installation.

## File and sandbox boundary

Players accept only the app's relative `/api/orgs/.../nodes/.../file?path=...`
URLs. The optional `media=true` query is a read-only playback representation.
The existing org/node resolution, folder scope, inbox-enabled check and explicitly
named mail/delivery file checks run before the media branch. There is no new
filesystem bridge, direct `file://` access, remote media URL or permission grant.
Electron sandbox, context isolation and no-Node settings remain in force.

The ordinary Download path is unchanged. Playback refuses nonregular files,
unknown extensions and files over the ceiling, then streams from one opened
handle in at most 64 KiB chunks with a size snapshot/take bound. Full reads return
200; one bounded/open-ended/suffix byte range returns 206. Invalid, multipart or
unsatisfiable ranges return 416 with `Content-Range: bytes */size`. Responses
use a fixed allowlisted media type, `nosniff` and `no-store`. Media files are
decoded as media, never executed as HTML. The private headers/path and stream
body use `#[nolog]`; existing outer file-route log suppression is retained.

Files can still change after admission. Growth cannot extend the response past
its captured size; truncation or replacement can make playback fail. This route
retains the existing canonical-path authorization and its local-disk race model;
it does not establish a new sandbox against a process that can rewrite those
authorized files.

## Tool parity and verification

Play, pause, seek and volume are local presentation controls with no durable
write. Agents still deliver/list the same files with the existing message,
file-delivery and `orgtree_files` tools within their ordinary authority. The
downloaded file is available to existing authorized file/shell/computer-use
workflows; there is no new tool granting file access or controlling a user's
audio output.

Focused mounted tests cover both delivery and message cards, no eager source,
explicit Play, source/offscreen/unmount cleanup, control-key ownership and
fallbacks. Native tests exercise the actual streaming module's ranges, exact
bodies, headers, cap and file-growth bound; the whole engine compile validates
its route integration. The isolated renderer capture generates synthetic WebM,
WAV and PNG files and exercises Chromium playback. It does not use live data,
an actual hub or the installed app. Full placement and platform hands-on checks
remain phase-2 release work.
