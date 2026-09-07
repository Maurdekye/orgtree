"""Real multiple-window positive controls; no backend imports or live requests."""
import functools
import http.server
import json
import os
from pathlib import Path
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
os.environ['ORGTREE_DATA'] = str(ROOT / 'tests' / '.popout-data')
assert Path(os.environ['ORGTREE_DATA']).resolve() != Path.home() / 'orgtree'

class FixtureHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_GET(self):
        if self.path.startswith(('/o/', '/k/')):
            self.path = '/index.html'
        try:
            super().do_GET()
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError):
            pass  # intentional child close/failed adoption aborts CSS loads

def main():
    handler = functools.partial(FixtureHandler, directory=str(ROOT / 'node_modules' / '.orgtree-popout-probe'))
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='msedge')
            context = browser.new_context()
            context.set_default_timeout(5000)
            page = context.new_page()
            page.set_default_timeout(5000)
            errors = []
            page.on('pageerror', lambda e: (errors.append(str(e)), print('PAGE ERROR:', str(e), flush=True)))
            page.goto(f'http://127.0.0.1:{server.server_port}')
            page.get_by_label('Draft', exact=True).fill('paragraph kept')
            page.get_by_label('Uncontrolled').fill('uncontrolled kept')
            page.locator('[data-scroll]').evaluate('(e) => e.scrollTop = 180')
            page.evaluate('window.original = document.querySelector("textarea")')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_label('Draft', exact=True).wait_for()
            assert child.get_by_label('Draft', exact=True).input_value() == 'paragraph kept'
            assert child.get_by_label('Uncontrolled').input_value() == 'uncontrolled kept'
            assert page.evaluate('probe.mounts()') == 1
            assert page.evaluate('original.ownerDocument !== document && original.isConnected')
            assert child.locator('[data-scroll]').evaluate('(e) => e.scrollTop') == 180
            results.append('same node, mount, controlled/uncontrolled values and scroll preserved')
            before = (page.locator('[data-bubble]').inner_text(), page.locator('[data-capture]').inner_text())
            child.get_by_label('Draft', exact=True).fill('child paragraph')
            child.get_by_role('button', name='Send fixture').click()
            child.locator('.popout-dependency').click(position={'x': 20, 'y': 8})
            assert child.locator('[data-sends]').inner_text() == '1'
            assert before == (page.locator('[data-bubble]').inner_text(), page.locator('[data-capture]').inner_text())
            results.append('child React interaction works, opener capture and bubble isolated')
            child.get_by_role('button', name='Confirm fixture', exact=True).click()
            child.get_by_role('dialog', name='Fixture confirmation').wait_for()
            assert page.get_by_role('dialog', name='Fixture confirmation').count() == 0
            child.keyboard.press('Escape')
            assert child.get_by_role('dialog', name='Fixture confirmation').count() == 0
            assert child.get_by_label('Draft', exact=True).input_value() == 'child paragraph'
            child.get_by_role('button', name='Pick fixture folder').click()
            child.get_by_role('button', name='select this folder').click()
            assert child.locator('[data-folder]').inner_text() == 'C:/fixture'
            assert page.locator('.picker-overlay').count() == 0
            child.get_by_alt_text('Fixture image', exact=True).click()
            assert child.locator('.lb-overlay').count() == 1
            assert page.locator('.lb-overlay').count() == 0
            child.keyboard.press('Escape')
            assert child.locator('.lb-overlay').count() == 0
            results.append('nested confirmation, folder picker and lightbox stay in child; Escape closes only child overlay')
            page.evaluate("document.documentElement.style.setProperty('--popout-proof', '17px'); const s = document.createElement('style'); s.id='cssom-proof'; document.head.append(s); s.sheet.insertRule('textarea { border-top: 7px solid rgb(1, 2, 3) !important }')")
            child.wait_for_function("getComputedStyle(document.documentElement).getPropertyValue('--popout-proof').trim() === '17px'")
            child.wait_for_function("getComputedStyle(document.querySelector('textarea')).borderTopWidth === '7px'")
            results.append('root theme properties and CSSOM-inserted styles synchronize')
            page.evaluate("const a=document.createElement('style'); a.id='cascade-a'; a.textContent='textarea { color: rgb(10, 0, 0) }'; const b=document.createElement('style'); b.id='cascade-b'; b.textContent='textarea { color: rgb(0, 0, 20) }'; document.head.append(a,b)")
            child.wait_for_function("getComputedStyle(document.querySelector('textarea')).color === 'rgb(0, 0, 20)'")
            page.evaluate("document.querySelector('#cascade-a').sheet.insertRule('textarea { color: rgb(20, 0, 0) }',1)")
            child.wait_for_function("document.querySelector('#cascade-a').textContent.includes('20, 0, 0')")
            assert child.locator('textarea').evaluate('(e) => getComputedStyle(e).color') == page.evaluate("getComputedStyle(original).color") == 'rgb(0, 0, 20)'
            page.evaluate("const c=document.createElement('style'); c.id='cascade-c'; c.textContent='textarea { color: rgb(0, 30, 0) }'; document.head.insertBefore(c,document.querySelector('#cascade-b'))")
            child.wait_for_function("document.querySelector('#cascade-c') !== null")
            assert child.locator('textarea').evaluate('(e) => getComputedStyle(e).color') == 'rgb(0, 0, 20)'
            page.evaluate("document.head.append(document.querySelector('#cascade-a'))")
            reordered = page.evaluate("getComputedStyle(original).color")
            assert reordered != 'rgb(0, 0, 20)', 'source reordering must change the cascade'
            child.wait_for_function("expected => getComputedStyle(document.querySelector('textarea')).color === expected", arg=reordered)
            results.append('multi-sheet cascade order matches after early-sheet insertRule, new middle sheet and explicit sheet reorder')
            child.close()
            page.get_by_label('Draft', exact=True).wait_for()
            assert page.get_by_label('Draft', exact=True).input_value() == 'child paragraph'
            assert page.evaluate('document.querySelector("textarea") === original && probe.mounts() === 1')
            results.append('native child close redocks same live draft')
            # A denied popup is a positive failure control, not an environment skip.
            page.evaluate('window.savedOpen = window.open; window.open = () => null')
            page.get_by_role('button', name='Open in new window').click()
            assert 'blocked' in page.get_by_role('alert').inner_text()
            assert page.get_by_label('Draft', exact=True).input_value() == 'child paragraph'
            page.evaluate('window.open = window.savedOpen')
            results.append('blocked popup preserves existing draft and gives feedback')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_label('Draft', exact=True).wait_for()
            page.evaluate('probe.restart("new-instance")')
            child.get_by_role('button', name='Keep working').click()
            child.get_by_role('button', name='Return to main window', exact=True).first.click()
            page.evaluate('probe.restart("new-instance")')
            assert page.get_by_label('Draft', exact=True).input_value() == 'child paragraph'
            results.append('deferred restart does not reload after return')
            # Fail on both sides of adoption. Each failure is injected into
            # the child's DOM methods, never into the source recovery anchor.
            for mode in ['style', 'close-during-style', 'before-adopt', 'after-adopt']:
                page.evaluate("""mode => {
                  const realOpen = window.open;
                  window.open = function(...args) {
                    const w = realOpen.apply(window, args);
                    window.open = realOpen;
                    const append = w.Node.prototype.appendChild;
                    let fired = false;
                    w.Node.prototype.appendChild = function(node) {
                      if (!fired && ((mode === 'style' || mode === 'close-during-style') && this === w.document.head)) {
                        fired = true;
                        if (mode === 'close-during-style') w.close();
                        throw new Error('injected style failure');
                      }
                      if (!fired && node.classList?.contains('movable-surface') && mode.includes('adopt')) {
                        fired = true;
                        if (mode === 'after-adopt') append.call(this, node);
                        throw new Error('injected adoption failure');
                      }
                      return append.call(this, node);
                    };
                    return w;
                  };
                }""", mode)
                page.get_by_role('button', name='Open in new window').click()
                assert page.get_by_role('alert').is_visible(), mode
                assert page.get_by_label('Draft', exact=True).input_value() == 'child paragraph', mode
                assert page.evaluate('document.querySelector("textarea") === original && original.isConnected && probe.mounts() === 1'), mode
                results.append(mode + ' returns same mounted draft')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_label('Draft', exact=True).wait_for()
            try:
                child.reload(timeout=3000)
            except Exception:
                pass  # refresh redocks and closes the dependent shell
            page.get_by_label('Draft', exact=True).wait_for()
            assert page.get_by_label('Draft', exact=True).input_value() == 'child paragraph'
            results.append('child refresh redocks live draft')
            # Real DeskChat + central host, not a second hand-written form.
            print('START DESK', flush=True)
            page.goto(f'http://127.0.0.1:{server.server_port}/?desk=1')
            print('DESK LOADED', flush=True)
            draft = page.get_by_placeholder('message builder\u2026', exact=True)
            draft.fill('generation four draft')
            page.locator('input[type=file]').set_input_files({'name': 'fixture.txt', 'mimeType': 'text/plain', 'buffer': b'fixture'})
            page.locator('.attach-chip').filter(has_text='fixture.txt').wait_for()
            page.evaluate('window.deskOriginal = document.querySelector("textarea")')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            page.evaluate('deskProbe.navigate()')
            child.get_by_placeholder('message builder\u2026', exact=True).fill('draft after camera departure')
            assert page.locator('textarea').count() == 0
            assert page.evaluate('deskOriginal.isConnected && deskOriginal.ownerDocument !== document')
            results.append('real desk remains single mounted writer after original slot disappears')
            page.evaluate('deskProbe.generation(); deskProbe.return()')
            page.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            assert page.get_by_placeholder('message builder\u2026', exact=True).input_value() == ''
            assert child.locator('textarea').input_value() == 'draft after camera departure'
            assert child.locator('.attach-chip').filter(has_text='fixture.txt').count() == 1
            assert page.locator('.attach-chip').filter(has_text='fixture.txt').count() == 0
            assert child.locator('textarea').is_disabled()
            assert 'identity changed' in child.get_by_role('status').inner_text()
            results.append('new generation starts empty and predecessor composer becomes unsendable')
            child.close()
            page.goto(f'http://127.0.0.1:{server.server_port}/?transition=1')
            page.get_by_label('Draft', exact=True).fill('org scoped draft')
            page.evaluate("history.replaceState(null, '', '/o/other'); history.pushState(null, '', '/o/fixture')")
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_label('Draft', exact=True).wait_for()
            page.go_back()
            dialog = page.get_by_role('dialog', name='Switch organizations')
            dialog.wait_for()
            assert page.locator('[data-org]').inner_text() == 'fixture'
            assert page.url.endswith('/o/fixture')
            dialog.get_by_role('button', name='Cancel', exact=True).click()
            assert child.get_by_label('Draft', exact=True).input_value() == 'org scoped draft'
            page.get_by_role('button', name='Other organization').click()
            page.get_by_role('dialog', name='Switch organizations').get_by_role('button', name='Return windows', exact=True).click()
            page.get_by_label('Draft', exact=True).wait_for()
            assert page.locator('[data-org]').inner_text() == 'fixture'
            assert page.get_by_label('Draft', exact=True).input_value() == 'org scoped draft'
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_label('Draft', exact=True).wait_for()
            page.get_by_role('button', name='Other organization').click()
            child.get_by_role('dialog', name='Switch organizations').get_by_role('button', name='Continue and switch', exact=True).click()
            assert page.locator('[data-org]').inner_text() == 'other'
            assert child.is_closed()
            results.append('back/forward cancellation keeps old org URL/state; Return preserves draft; explicit Continue switches')
            # Real canvas: migrate the same desk into an existing pin, then
            # pop it out, interact, resize, and return with its pin intact.
            page.goto(f'http://127.0.0.1:{server.server_port}/?canvas=1')
            page.wait_for_timeout(2200)  # initial tree layout and camera springs
            page.locator('.sq').filter(has_text='builder').click(force=True)
            draft = page.get_by_placeholder('message builder\u2026', exact=True)
            draft.wait_for()
            draft.fill('canvas pin draft')
            page.evaluate('window.canvasDraft = document.querySelector("textarea")')
            page.get_by_role('button', name="pin builder's desk as a window", exact=True).click()
            page.locator('.pinwin textarea').wait_for()
            assert page.locator('.pinwin textarea').input_value() == 'canvas pin draft'
            assert page.evaluate('document.querySelector("textarea") === canvasDraft')
            pin = page.evaluate("localStorage.getItem('orgtree-pins-fixture')")
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window', exact=True).click()
            child = popup.value
            child.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            page.wait_for_timeout(600)  # let the existing camera spring settle
            camera = page.locator('.space').get_attribute('style')
            focused = page.locator('.sq.desk').count()
            child.get_by_placeholder('message builder\u2026', exact=True).fill('changed in real child')
            child.locator('.popout-dependency').click(position={'x': 20, 'y': 8})
            child.mouse.move(25, 20); child.mouse.down(); child.mouse.move(160, 40, steps=5); child.mouse.up()
            child.mouse.wheel(0, 120); child.keyboard.press('Shift'); child.keyboard.press('Escape')
            assert page.locator('.space').get_attribute('style') == camera
            assert page.locator('.sq.desk').count() == focused
            assert page.locator('textarea').count() == 0
            child.set_viewport_size({'width': 430, 'height': 720})
            assert child.evaluate('!document.documentElement.classList.contains("mobile")')
            assert child.locator('textarea').bounding_box()['width'] > 120
            assert child.evaluate('document.body.scrollWidth <= innerWidth + 1')
            artifact = ROOT / 'node_modules' / '.orgtree-popout-probe' / 'narrow-desk.png'
            child.screenshot(path=str(artifact))
            child.get_by_role('button', name='settings for builder', exact=True).click()
            child.locator('.settings').wait_for()
            assert page.locator('.settings').count() == 0
            child.locator('.settings').evaluate('(e) => e.dataset.popoutPreserved = "yes"')
            child.close()
            page.locator('.settings[data-popout-preserved=yes]').wait_for()
            page.keyboard.press('Escape')
            page.locator('.pinwin textarea').wait_for()
            assert page.locator('.pinwin textarea').input_value() == 'changed in real child'
            assert page.evaluate('document.querySelector("textarea") === canvasDraft')
            assert page.evaluate("localStorage.getItem('orgtree-pins-fixture')") == pin
            results.append('actual canvas pin keeps same composer and geometry; child gestures leave camera alone; narrow child remains desktop; App-owned settings follow and return')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window', exact=True).click()
            child = popup.value
            child.locator('textarea').wait_for()
            page.evaluate("canvasProbe.rename('renamed')")
            child.get_by_placeholder('message renamed\u2026', exact=True).wait_for()
            assert child.locator('textarea').input_value() == 'changed in real child'
            assert page.evaluate('canvasDraft.isConnected && canvasDraft.ownerDocument !== document')
            assert child.locator('textarea').count() == 1 and page.locator('textarea').count() == 0
            page.evaluate("canvasProbe.rename('builder')")
            child.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            assert child.locator('textarea').input_value() == 'changed in real child'
            child.close()
            page.locator('.pinwin textarea').wait_for()
            assert page.evaluate('document.querySelector("textarea") === canvasDraft')
            results.append('detached real desk survives validated rename and reverse rename with same DOM, draft and single writer')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window', exact=True).click()
            child = popup.value
            child.locator('textarea').wait_for()
            page.evaluate("canvasProbe.payloadRename('payload-renamed')")
            child.get_by_placeholder('message payload-renamed\u2026', exact=True).wait_for()
            assert page.evaluate('canvasDraft.isConnected && canvasDraft.ownerDocument !== document')
            assert child.locator('textarea').input_value() == 'changed in real child'
            assert child.locator('textarea').is_enabled(), 'payload-only rename must keep send capability'
            page.evaluate("canvasProbe.payloadRename('builder')")
            child.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            assert child.locator('textarea').is_enabled(), 'payload-only reverse rename must keep send capability'
            child.locator('.cc-send').click()
            assert page.evaluate("probe.requests.some(u => u.includes('/nodes/builder/message'))")
            child.close()
            results.append('payload-only same-session rename and reverse preserve same DOM/draft and valid new-name sending')
            page.evaluate("localStorage.setItem('orgtree-draft-v2-[\"other\",\"new-agent\",7]', 'other org protected draft'); canvasProbe.beginOrg()")
            page.wait_for_timeout(100)
            assert page.locator('textarea').count() == 0, 'old-tree/new-slug must not create a composer'
            assert not page.evaluate("probe.requests.some(u => u.includes('/orgs/other/nodes/builder/'))"), 'old agent callbacks must not use new slug'
            page.evaluate('canvasProbe.finishOrg()')
            page.wait_for_timeout(2200)
            page.locator('.sq').filter(has_text='new-agent').click(force=True)
            page.get_by_placeholder('message new-agent\u2026', exact=True).wait_for()
            assert page.locator('textarea').input_value() == 'other org protected draft'
            assert page.locator('textarea').is_enabled()
            results.append('old-tree/new-slug gap mounts no composer or wrong-org request; matching new tree restores its own enabled draft')
            page.goto(f'http://127.0.0.1:{server.server_port}/?advanced=1')
            page.get_by_label('Draft', exact=True).fill('advanced form draft')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window', exact=True).click()
            child = popup.value
            assert child.get_by_label('Draft', exact=True).input_value() == 'advanced form draft'
            child.close()
            assert page.get_by_label('Draft', exact=True).input_value() == 'advanced form draft'
            results.append('actual advanced new-org dialog offers popout and keeps its form on native return')
            page.goto(f'http://127.0.0.1:{server.server_port}/?scope=1')
            page.get_by_role('heading', name='permissions', exact=False).wait_for()
            assert page.locator('.settings').evaluate('(e) => Math.abs(e.getBoundingClientRect().width - e.offsetWidth) < 1')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window', exact=True).click()
            child = popup.value
            child.get_by_role('heading', name='permissions', exact=False).wait_for()
            child.close()
            assert page.locator('.settings').evaluate('(e) => Math.abs(e.getBoundingClientRect().width - e.offsetWidth) < 1')
            results.append('actual draft permissions remains outside canvas transform before popout and after return')
            page.goto(f'http://127.0.0.1:{server.server_port}/?desk=1&missinggen=1')
            page.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            assert page.get_by_role('button', name='Open in new window').count() == 0
            results.append('missing public generation disables separate ownership instead of defaulting to generation zero')
            page.goto(f'http://127.0.0.1:{server.server_port}/?desk=1')
            page.locator('textarea').fill('removed agent recovery')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window', exact=True).click()
            child = popup.value
            child.locator('textarea').wait_for()
            page.evaluate('deskProbe.remove()')
            assert child.locator('textarea').is_disabled()
            page.evaluate('deskProbe.namesake()')
            page.locator('textarea').wait_for()
            assert page.locator('textarea').input_value() == ''
            assert child.locator('textarea').is_disabled()
            page.get_by_text('Older unsent drafts', exact=False).click()
            assert page.locator('.popout-draft-recovery').inner_text().find('removed agent recovery') >= 0
            child.close()
            results.append('observed deletion permanently disables predecessor; same-generation namesake gets empty composer and explicit recoverable old text')
            page.goto(f'http://127.0.0.1:{server.server_port}/?desk=1&retired=1')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window', exact=True).click()
            child = popup.value
            child.get_by_text('no conversation yet', exact=True).wait_for()
            child.close()
            page.get_by_text('no conversation yet', exact=True).wait_for()
            results.append('readable archived desk can pop out and return')
            # Exercise the actual API restart detector as well as its policy.
            page.goto(f'http://127.0.0.1:{server.server_port}/?desk=1')
            page.get_by_placeholder('message builder\u2026', exact=True).fill('persist through accepted reload')
            page.evaluate('probe.api()')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            page.evaluate('probe.apiRestart()')
            child.get_by_role('button', name='Reload now', exact=True).wait_for()
            with page.expect_navigation():
                child.get_by_role('button', name='Reload now', exact=True).click()
            page.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            assert page.get_by_placeholder('message builder\u2026', exact=True).input_value() == 'persist through accepted reload'
            assert child.is_closed()
            results.append('actual API restart waits for explicit reload; opener reloads, child closes, composer restores')
            page.goto(f'http://127.0.0.1:{server.server_port}/k/probe-token/?desk=1&public=1')
            page.get_by_placeholder('message builder\u2026', exact=True).fill('visitor draft')
            with page.expect_popup() as popup:
                page.get_by_role('button', name='Open in new window').click()
            child = popup.value
            child.get_by_placeholder('message builder\u2026', exact=True).wait_for()
            assert child.url == 'about:blank'
            assert page.evaluate("probe.requests.length > 0 && probe.requests.every(u => u.startsWith('/k/probe-token/'))")
            page.evaluate('deskProbe.generation()')
            assert child.locator('textarea').is_disabled()
            results.append('public nonzero-generation desk uses opener kiosk API prefix without loading token URL in child')
            page.on('dialog', lambda dialog: dialog.accept())
            page.close(run_before_unload=True)
            child.wait_for_event('close') if not child.is_closed() else None
            results.append('accepted parent close closes dependent child')
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown(); server.server_close(); thread.join()
    print(json.dumps({'passed': results}, indent=2))

if __name__ == '__main__':
    main()
