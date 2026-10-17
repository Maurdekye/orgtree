# Markdown image embeds

Chat and mail Markdown is sanitized before the renderer rewrites image sources.
Relative image paths keep using the author's existing `/file` route. Absolute
Windows drive paths and HTTP(S) URLs use the engine's authenticated
`/api/markdown-image` endpoint. Images that fail to load leave a link to the
original web URL or a reveal-in-folder link for a local path.

The image endpoint accepts PNG, JPEG, GIF and WebP. It rejects SVG and all
other formats. Validation uses content signatures rather than filenames or
remote `Content-Type` headers. The initial limits are 10 MiB encoded bytes,
16 million pixels, and 8192 pixels on either dimension. Responses use the
validated media type, `X-Content-Type-Options: nosniff`, and `Cache-Control:
no-store`.

Remote images are fetched automatically because that is the user's ruling for
this feature. The fetch accepts HTTP and HTTPS only, rejects userinfo, sends no
desktop credentials or cookies, disables environment proxies, and has a
12-second timeout. Hostnames are resolved by the engine, checked for public
addresses, and pinned to an accepted address for the request. Redirects are
handled manually, limited to five, and validated again at each hop. The
download is streamed and stopped at the byte limit.

The route uses the same per-launch desktop token as other API calls. The engine
omits its query string from request and response logs because it contains
absolute local paths or complete remote URLs. SVG is excluded rather than
sanitized.

For local images, the engine accepts only lexical absolute drive-letter paths,
checks each path component without following symlinks or reparse points, and
checks the opened handle's final path and regular-file type before reading.
These checks reject crafted UNC/device paths and local junction aliases. A
local attacker who can write to and replace path components may still race the
component checks and open; this local-disk race is a known limitation and is
outside the untrusted-Markdown threat addressed by this route.
