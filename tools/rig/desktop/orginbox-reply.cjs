// The org inbox panel's Reply (mail hub v2, Orgtree 4.0.2): open the panel
// from the canvas tile, select the inbound row whose body holds args.row,
// read the reading pane (it quotes what that row answers), attach args.file
// the way the file picker does, reply from the pane with args.reply, then
// read the mailservers tab (the hub's version).
// args: { row: "<token in the inbound body>", reply: "<the reply's text>",
//         file: { name, text } }
module.exports = async (page, { args }) => {
  await page.waitFor('.sq.orginbox', { timeout: 30000 })
  const tile = await page.eval(() => document.querySelector('.sq.orginbox .oi-dot')?.getAttribute('title') || '')
  await page.click('.sq.orginbox')
  await page.waitFor('.mailer-list .mailrow', { timeout: 30000 })
  await page.sleep(800)
  await page.screenshot('panel')
  const rows = await page.eval(() => [...document.querySelectorAll('.mailer-list .mailrow')].map((r) => (r.innerText || '').trim().slice(0, 160)))
  if (!rows.some((r) => r.includes(args.row))) return { rows, missing: args.row }
  // the innermost element of the row holding the token (text matches are exact unless regex)
  await page.click({ selector: '.mailer-list .mailrow *', text: args.row, regex: true })
  await page.waitFor('.mailer-read .mail-reply textarea')
  await page.sleep(500)
  const pane = await page.eval(() => (document.querySelector('.mailer-read')?.innerText || '').trim())
  // an outside recipient: no notice toggle; files are staged the org inbox's way
  const buttons = await page.eval(() => [...document.querySelectorAll('.mailer-read .mail-reply button')]
    .map((b) => ({ label: b.getAttribute('aria-label') || b.getAttribute('title') || (b.innerText || '').trim(), disabled: b.disabled })))
  await page.screenshot('reading-pane')
  if (args.file) {
    // what choosing a file in the picker hands the input
    await page.eval((name, text) => {
      const input = document.querySelector('.mailer-read .mail-reply input[type=file]')
      const dt = new DataTransfer()
      dt.items.add(new File([text], name, { type: 'text/plain' }))
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, args.file.name, args.file.text)
    await page.waitFor({ selector: '.mailer-read .attach-chip', text: args.file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), regex: true }, { timeout: 20000 })
  }
  await page.click('.mailer-read .mail-reply textarea')
  await page.type(args.reply)
  await page.screenshot('reply-typed')
  await page.click('.mailer-read .mail-reply-send')
  await page.waitFor(() => /replied to @net:/.test(document.body.innerText), { timeout: 20000 })
  await page.screenshot('replied')
  await page.click({ selector: 'button.adv-tab', text: 'mailservers' })
  await page.waitFor(() => /hub version/.test(document.querySelector('.oi-net')?.innerText || ''), { timeout: 20000 })
  const servers = await page.eval(() => (document.querySelector('.oi-net')?.innerText || '').trim())
  await page.screenshot('mailservers')
  return { tile, pane: pane.slice(0, 800), buttons, servers: servers.slice(0, 600) }
}
