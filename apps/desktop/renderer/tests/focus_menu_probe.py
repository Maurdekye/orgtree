"""Exercise Focus with a real Canvas/Attention registry and a long synthetic chat."""
import sys
from pathlib import Path
REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / 'tools'))
from assert_repo_import import assert_repo_import
provenance = assert_repo_import(REPO)

import functools
import http.server
import json
import subprocess
import threading
import socket
import time
import urllib.request
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve()
OUT.relative_to(REPO / 'artifacts')
OUT.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', str(HERE / 'attentionlayout_build.mjs'), str(OUT / 'build'),
                'focus-menu-probe.tsx'], check=True)
html = OUT / 'build' / 'probe.html'
html.write_text(html.read_text(encoding='utf-8').replace('<meta charset="utf-8">',
    '<meta charset="utf-8"><base href="/">'), encoding='utf-8')

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def translate_path(self, path):
        if path.startswith('/o/focus-probe'):
            path = '/probe.html'
        return super().translate_path(path)

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0),
    functools.partial(Handler, directory=str(OUT / 'build')))
threading.Thread(target=server.serve_forever, daemon=True).start()
result = {'errors': [], 'provenance': str(provenance), 'focus': []}
try:
    with sync_playwright() as p:
        electron = len(sys.argv) > 2 and sys.argv[2] == 'electron'
        native_process = None
        if electron:
            subprocess.run(['node', str(HERE / 'focus_native_build.mjs'), str(OUT)], cwd=REPO, check=True)
            executable = subprocess.check_output(['node', '-p', "require('electron')"], cwd=REPO, text=True).strip()
            with socket.socket() as endpoint:
                endpoint.bind(('127.0.0.1', 0))
                debug_port = endpoint.getsockname()[1]
            native_main = OUT / 'native-main.cjs'
            origin = f'http://127.0.0.1:{server.server_port}'
            native_main.write_text("const {app,BrowserWindow,ipcMain}=require('electron'); const path=require('node:path');\n"
                "for(const name of ['userData','sessionData','cache','temp','logs','crashDumps']) app.setPath(name,path.join(__dirname,name));\n"
                "app.disableHardwareAcceleration();\n"
                "const identity={windowId:'focus-window',kind:'org',org:'focus-probe',notificationOwner:false};\n"
                "ipcMain.on('desktop:window-identity-sync',(e)=>{console.log('IPC sync identity',e.sender.id);e.returnValue={identity,token:'probe-token'};});\n"
                "ipcMain.on('desktop:events-listening',(e)=>console.log('IPC events-listening',e.sender.id));\n"
                "const replies={'desktop:window-identity':identity,'desktop:app-version':'3.0.0-alpha.9','desktop:preferences':{},'desktop:set-preferences':{},'desktop:update-status':{},'desktop:request-org':{action:'focused',org:'focus-probe'},'desktop:popout-state':{maximized:false},'desktop:window-state':{maximized:false},'desktop:window-controls-state':{maximized:false},'desktop:status':{},'desktop:open-orgs':[]};\n"
                "for(const name of [...Object.keys(replies),'desktop:notify','desktop:sync-notifications','desktop:pending-attention','desktop:set-effective-theme','desktop:take-pending-events']) ipcMain.handle(name,(e,...args)=>{console.log('IPC',name,e.sender.id,JSON.stringify(args));return replies[name]??null;});\n"
                "const {configureWindow}=require('./native-windows.cjs');\n"
                "const register=(w,portal)=>{console.log('WINDOW',w.id,portal);const set=w.webContents.setWindowOpenHandler.bind(w.webContents);w.webContents.setWindowOpenHandler=(handle)=>set(details=>{const answer=handle(details);console.log('OPEN',details.frameName,answer.action);if(answer.action==='allow') answer.overrideBrowserWindowOptions={...answer.overrideBrowserWindowOptions,show:false};return answer;});};\n"
                "app.whenReady().then(()=>{const w=new BrowserWindow({show:false,width:1600,height:900,webPreferences:{contextIsolation:true,sandbox:true,preload:path.join(__dirname,'native-preload.cjs'),additionalArguments:["
                + json.dumps(f'--orgtree-ui-origin={origin}') + "]}});"
                + f"configureWindow(w,{json.dumps(origin)},true,register);w.loadURL('{origin}/o/focus-probe#detached');" + "});\n", encoding='utf-8')
            native_log = (OUT / 'native-log.txt').open('w', encoding='utf-8')
            native_process = subprocess.Popen([executable, f'--remote-debugging-port={debug_port}', str(native_main)],
                stdout=native_log, stderr=native_log, creationflags=subprocess.CREATE_NO_WINDOW)
            for _ in range(50):
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json/version', timeout=.2)
                    break
                except Exception:
                    time.sleep(.1)
            browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{debug_port}')
            page = browser.contexts[0].pages[0]
        else:
            browser = p.chromium.launch(channel='msedge')
            page = browser.new_page(viewport={'width': 1600, 'height': 900})
        page.set_default_timeout(15000)
        page.on('pageerror', lambda e: result['errors'].append(str(e)))
        if len(sys.argv) > 3:
            copied_path = Path(sys.argv[3]).resolve()
            copied_path.relative_to(REPO / 'artifacts')
            copied = json.loads(copied_path.read_text(encoding='utf-8'))
            page.add_init_script('window.copiedMessages = ' + json.dumps(copied))
            result['copiedMessages'] = len(copied)
            target_path = copied_path.with_name('coordinator-sol-messages.json')
            if target_path.exists():
                target = json.loads(target_path.read_text(encoding='utf-8'))
                page.add_init_script('window.targetCopiedMessages = ' + json.dumps(target))
                result['targetCopiedMessages'] = len(target)
            graph_path = copied_path.with_name('organization-roots.json')
            if graph_path.exists():
                graph = json.loads(graph_path.read_text(encoding='utf-8'))
                page.add_init_script('window.copiedRoots = ' + json.dumps(graph))
                result['copiedRoots'] = len(graph)
        popouts = len(sys.argv) > 2 and sys.argv[2] in ['popouts', 'electron']
        scene = '#detached' if popouts else '#' + sys.argv[2] if len(sys.argv) > 2 else ''
        page.goto(f'http://127.0.0.1:{server.server_port}' + ('/o/focus-probe' if electron else '/probe.html') + scene)
        page.wait_for_timeout(2200)
        if scene == '#detached':
            page.wait_for_selector('.attn-backdrop-message')
            desk_page = page
            page.evaluate("window.changeView('canvas')")
            card = page.locator('.attn-desk .desk-nav-chip').filter(has_text='beta')
            card.click(button='right')
            page.get_by_role('menuitem', name='Focus', exact=True).click()
            page.wait_for_timeout(1500)
            result['priorCanvasDesk'] = page.locator('[data-first-use-agent="beta"].desk .cc-composer').count()
            assert result['priorCanvasDesk'] == 1, 'positive control: target really owns a zoomed Canvas desk before Attention'
            page.evaluate("window.changeView('attention')")
            page.wait_for_timeout(400)
            if popouts:
                with page.expect_popup() as queue_event:
                    page.locator('.attn-panel-queue .popout-button').click()
                queue_page = queue_event.value
                with page.expect_popup() as desk_event:
                    page.locator('.attn-panel-desk .popout-button').click()
                desk_page = desk_event.value
                desk_page.on('pageerror', lambda e: result['errors'].append(str(e)))
                desk_page.wait_for_selector('.attn-desk .cc-composer')
            card = desk_page.locator('.attn-desk .desk-nav-chip').filter(has_text='beta')
            result['jumpCard'] = card.inner_text()
            result['loadedMessages'] = page.evaluate('window.loadedProbeMessages')
            result['pinnedPanels'] = page.locator('.modalpin-bar.on').count()
            card.click(button='right')
            if not electron:
                desk_page.screenshot(path=str(OUT / 'before-focus.png'))
            debug = page.context.new_cdp_session(page)
            debug.send('Debugger.enable')
            debug.on('Debugger.paused', lambda event: result.update({'pause': event['callFrames']}))
            try:
                desk_page.get_by_role('menuitem', name='Focus', exact=True).click()
            except Exception:
                debug.send('Debugger.pause')
                debug.send('Runtime.evaluate', {'expression': '0'})
                debug.send('Debugger.resume')
                raise
            page.wait_for_timeout(300)
            desk_page.wait_for_selector('.attn-desk .msg', state='attached')
            result['targetRenderedMessages'] = desk_page.locator('.attn-desk .msg').count()
            result['childFocus'] = desk_page.locator('.attn-desk .cc-head-left').inner_text()
            result['heartbeat'] = page.evaluate('1+1')
            if electron:
                result['nativePages'] = [p.url for p in browser.contexts[0].pages]
                result['childBridge'] = desk_page.evaluate("typeof window.orgtreeDesktop")
                assert result['childBridge'] == 'undefined', 'production preload must not boot a second bridge in the adopted portal'
            if not electron:
                desk_page.screenshot(path=str(OUT / 'after-focus.png'))
            assert 'beta' in result['childFocus'], result
            assert result['heartbeat'] == 2
            assert not result['errors'], result
            print(json.dumps(result, indent=2))
            print('PASS detached child jump-card Focus')
            browser.close()
            sys.exit(0)
        try:
            page.locator('[data-first-use-agent="alpha"]').click()
        except Exception:
            result['startupBody'] = page.locator('body').inner_text()
            page.screenshot(path=str(OUT / 'startup-failure.png'))
            raise
        page.wait_for_selector('[data-first-use-agent="alpha"].desk .cc-composer')
        page.wait_for_timeout(2000)
        result['camera'] = page.locator('.space').get_attribute('style')
        result['canvasMessages'] = page.locator('[data-first-use-agent="alpha"].desk').inner_text().count('Message ')
        page.evaluate("window.changeView('attention')")
        page.wait_for_timeout(400)
        result['attentionOwnsDesk'] = page.locator('.attn-desk .cc-composer').count() == 1
        # Even old code's placeholder must leave the drawer's Focus usable.
        for agent in ['beta', 'alpha', 'beta', 'beta']:
            toggle = page.locator('.attn-agents-toggle')
            if toggle.get_attribute('aria-expanded') != 'true':
                toggle.click()
            page.locator(f'[data-attn-agent="{agent}"]').click(button='right')
            page.get_by_role('menuitem', name='Focus', exact=True).click()
            page.wait_for_timeout(300)
            result['focus'].append({'agent': agent,
                'selected': page.locator('[data-attn-agent][aria-selected="true"]').get_attribute('data-attn-agent'),
                'desk': page.locator('.attn-desk .cc-composer').count(),
                'heartbeat': page.evaluate('1 + 1')})
        page.screenshot(path=str(OUT / 'attention-focus.png'))
        page.locator('.attn-agents-toggle[aria-expanded="true"]').click()
        page.locator('.attn-desk .cc-head-left').click(button='right')
        page.get_by_role('menuitem', name='Focus', exact=True).click()
        result['headerFocusHeartbeat'] = page.evaluate('1 + 1')
        page.locator('.attn-desk .cc-head-left').click(button='right')
        page.get_by_role('menuitem', name='Open desk', exact=True).click()
        page.wait_for_selector('.tempdesk-panel .cc-composer')
        result['temporaryDesk'] = page.locator('.tempdesk-panel .cc-composer').count()
        page.keyboard.press('Escape')
        result['temporaryHeartbeat'] = page.evaluate('1 + 1')
        page.evaluate("window.changeView('canvas')")
        page.wait_for_selector('[data-first-use-agent="alpha"].desk .cc-composer')
        result['cameraAfter'] = page.locator('.space').get_attribute('style')
        browser.close()
finally:
    if 'native_process' in locals() and native_process:
        subprocess.run(['taskkill', '/PID', str(native_process.pid), '/T', '/F'], capture_output=True)
        native_log.close()
    server.shutdown()
    (OUT / 'measurements.json').write_text(json.dumps(result, indent=2), encoding='utf-8')

assert result['canvasMessages'] > 0, 'positive control: long transcript really loaded'
assert not result['errors'], result['errors']
assert result['camera'] == result['cameraAfter'], 'Focus moved the hidden Canvas camera'
assert all(x['selected'] == x['agent'] and x['heartbeat'] == 2 for x in result['focus']), result
print(json.dumps(result, indent=2))
print('PASS: real Edge Focus remains responsive with a long transcript and a zoomed Canvas desk')
