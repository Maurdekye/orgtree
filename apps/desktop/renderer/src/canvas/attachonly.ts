/** A MESSAGE THAT IS ONLY FILES HAS NO TEXT LINE (USER 2026-11-26 m2b7a281ca223: "if i send just a picture
 *  with no message, dont say "(file attached)" in the message"). Composers send such a message with an empty
 *  text; earlier versions sent this placeholder instead, so mail already saved with it renders the same way. */
export const OLD_ATTACHMENT_PLACEHOLDER = '(file attached)'

/** Whether `body` is no text of its own beside `attachments`: empty, or the old placeholder, on a message that
 *  carries at least one file. A message that says "(file attached)" with no file keeps its words. */
export function attachmentOnlyBody(body: unknown, attachments: unknown): boolean {
  if (!Array.isArray(attachments) || attachments.length === 0 || typeof body !== 'string') return false
  const t = body.trim()
  return t === '' || t === OLD_ATTACHMENT_PLACEHOLDER
}
