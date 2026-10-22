# Orgtree 4.4.1

Orgtree 4.4.1 is a fix release for 4.4.0. Transcripts scroll back reliably, missing files show the path that was tried, hiring above an agent from the canvas works again, tickets can be mentioned, and simultaneous changes retry instead of failing.

## Transcripts and desks

- **Scrolling back through a transcript loads all earlier history.** A long conversation no longer stops early with a false "start of the conversation" marker, for every harness.
- **Tool rows for a file that does not exist show the full path that was tried**, with a **Copy path** action, instead of hiding it.
- **Mention** is the first entry on every ticket link's menu inside a desk, including the ticket cards in the idle docket reminder. Tickets also appear in the composer's **@** completion list.
- The idle docket reminder draws its items as ticket cards.

## Organization changes

- **Hiring a superior above an agent from the canvas** places the new agent at the chosen position again.
- **Changes made at the same moment retry automatically.** When two tree changes such as retires or moves collide, the engine retries them with short randomized waits. If a change still collides after several tries, it is refused with a message saying nothing changed and to try again.
- A turn that is still starting is shown as running, not as a turn the engine stopped mid-way.

## Notes

- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
