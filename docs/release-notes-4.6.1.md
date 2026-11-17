# Orgtree 4.6.1

Orgtree 4.6.1 shows a desk live in every place it's open: on its canvas card, in a pin, in its own window and in the Attention view at once, with one shared draft. Pinned, floating and popped-out desks can become attention desks. Files an agent sends can now be up to 32 GiB, and images and videos in transcripts written before a data move load again. The desktop is smoother: GPU shaders are kept between launches, and the window no longer stalls while Orgtree starts programs in the background. Orgtree no longer ships a Python runtime. It still bundles Mail hub 2.4.0 and works with Hubchat 1.3.6.

## Desks

- **One desk, every place.** A desk open in several places (its canvas card, a pin, the Attention view, the floating desk, a window of its own) shows live in all of them. There's no more "open elsewhere" placeholder, and a pinned agent's canvas card opens the same desk as its pin.
- **One draft per agent.** What you type for an agent is the same draft in every place its desk is open.
- **Your place in the transcript.** A place you leave remembers where you had scrolled in its desk and goes back there when you return.
- **Desk windows.** A popped-out desk opens over the place it came from, and that place keeps its own desk. **Close** ends the window and remembers its place; windows still open when you quit come back at the next start. A desk whose agent has moved on stays open, read-only, with the notice that its draft is in the message history.
- **Attention desks.** A pinned desk, the floating desk and a desk in its own window have a list icon in the header, beside pin and pop-out: **Make attention desk** turns that desk into an Attention view agent desk with its own selection. Several can be open at once, and a desk window stays an attention desk at the next start. **Make plain desk** turns it back.

## Files and links

- **Bigger files from agents.** Agents can send files up to 32 GiB with `orgtree_send_file` (was 256 MiB). **Download** saves them straight to disk where you choose, never loading them into memory. The copy is refused up front if the drive is short of space, and a failed copy leaves no partial file.
- **Transcript links after a data move.** Images, videos and file links in transcripts written before a **Data location** move open from the same place in the new folder, even after the old folder is deleted. Nothing stored is rewritten.
- **Local file links on Linux and macOS.** Absolute paths and `file:///` links open as local files there, and the engine's own address never opens in the browser.

## Smoother desktop

- **GPU shaders are kept.** Electron 44.11.3 keeps compiled GPU shaders between launches. After an install, an Electron update or a graphics driver update, Orgtree draws a hidden window once while you're idle, so the first desks you open don't stutter.
- **No stalls from background programs.** The window no longer freezes while Orgtree starts helper programs or waits on the disk in the background.
- **Lighter rendering.** The rainbow canvas background and the message bodies redraw less work each frame.
- **Stall reports.** When the window stalls while waiting on the graphics card, Orgtree records one short, filtered graphics trace in its diagnostics folder for troubleshooting. It never holds page text or addresses. `ORGTREE_STALLTRACE=0` turns it off.

## Fixes

- **A failed start says so.** If Orgtree can't start, it writes the reason to its diagnostics folder and the tray says **Orgtree could not start**; right-click it to see the error again.
- **Accounts.** Quick chat's model tokens and the Accounts panel's **preview** tag count a signed-in registered account, as hiring does, also with an engine older than 4.6.0.
- **App settings.** The Live feed setting no longer closes App settings when the engine sends no agent list.
- **Preferences at quit.** A preferences save at quit is no longer overwritten by an older save still finishing.

## Notes

- **No Python.** The installer, the engine and the database setup no longer use or ship a Python runtime. The post-install relaunch is a small Rust program.
- No database changes.
- The standalone (headless) engine ships as the Linux archive, the Docker image on this release and `ghcr.io/maurdekye/orgtree-engine:4.6.1`, plus the agents image `:4.6.1-agents`. These packages are optional: the desktop app doesn't need them.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
