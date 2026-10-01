"""Measure provider hover/focus on the real App, with fake data and no engine."""
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
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]).resolve()
OUT.relative_to(REPO / 'artifacts')
OUT.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', str(HERE / 'appchrome-build.mjs'), str(OUT / 'build')], check=True)

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_GET(self):
        if '.' not in self.path.split('?')[0].rsplit('/', 1)[-1]:
            self.path = '/index.html'
        super().do_GET()

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(OUT / 'build')))
threading.Thread(target=server.serve_forever, daemon=True).start()
result = {'cases': [], 'errors': []}
MEASURE = """(arg) => {
  const target = document.querySelector(arg.selector), scope = arg.scope ? document.querySelector(arg.scope) : document.documentElement;
  if (!target || !scope) throw Error('missing measured control or scope');
  const probe = document.createElement('span'); probe.style.color = `var(${arg.token})`; scope.append(probe);
  const expected = getComputedStyle(probe).color; probe.remove();
  const s = getComputedStyle(target);
  return {expected, border:s.borderTopColor, outline:s.outlineColor, focusVisible:target.matches(':focus-visible')};
}"""
def measure_border(page, selector, token):
    arg = {'selector': selector, 'token': token}
    # Production buttons animate their border; measure the settled state.
    page.wait_for_function(f'arg => {{ const r = ({MEASURE})(arg); return r.border === r.expected; }}', arg=arg)
    return page.evaluate(MEASURE, arg)

def measure_primary(page, token):
    # A representative production primary control, without invoking an action.
    page.evaluate('''() => {
      const b = document.createElement('button'); b.className = 'primary';
      b.dataset.primaryProbe = ''; b.textContent = 'primary';
      b.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999999';
      document.querySelector('.app').append(b);
    }''')
    selector = '[data-primary-probe]'
    text_before = page.locator(selector).evaluate('b => getComputedStyle(b).color')
    page.locator(selector).hover()
    value = measure_border(page, selector, token)
    page.wait_for_function('''() => {
      const b = document.querySelector('[data-primary-probe]'), p = document.createElement('span');
      p.style.color = 'var(--accent-hover)'; b.append(p);
      const expected = getComputedStyle(p).color; p.remove();
      return getComputedStyle(b).backgroundColor === expected;
    }''')
    fill = page.locator(selector).evaluate('''b => {
      const p = document.createElement('span'); p.style.color = 'var(--accent-hover)';
      b.append(p); const expected = getComputedStyle(p).color; p.remove();
      return {expected, background:getComputedStyle(b).backgroundColor, text:getComputedStyle(b).color};
    }''')
    assert fill['background'] == fill['expected'] and fill['text'] == text_before, fill
    page.locator(selector).evaluate('b => b.remove()')
    return {'frame':value, 'fill':fill}

def measure_states(page, token):
    states = ['acct-secondary-btn acct-refresh-btn', 'acct-secondary-btn',
      'cc-eff set', 'cc-eff inherited', 'cc-notice-toggle armed', 'badge queued',
      'badge frozen', 'badge serving-account', 'badge retired-fold', 'badge audience-fold',
      'ask-submit', 'cmp-chip on', 'adv-tab on', 'ask-tabbtn on', 'eye-tab on',
      'eye-tab pinned', 'eye-auto on', 'onboard-theme selected', 'doc-badge',
      'doc-chip', 'cc-attach', 'pin-placeholder-btn', 'maillink worklink']
    values = []
    for cls, scope, expected_token in [(s, '', token) for s in states] + [
      ('cc-eff set', 'prov-openai', '--prov-openai'),
      ('cc-notice-toggle armed', 'prov-google', '--prov-google')]:
        page.mouse.move(0, 0)
        page.evaluate('''arg => {
          const wrap = document.createElement('div'); wrap.dataset.statesProbe = '';
          wrap.className = arg.scope; wrap.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:999999';
          const b = document.createElement('button'); b.className = arg.cls; b.textContent = arg.cls;
          wrap.append(b); document.querySelector('.app').append(wrap);
        }''', {'scope':scope, 'cls':cls})
        selector = '[data-states-probe] > button'
        idle = page.locator(selector).evaluate('b => getComputedStyle(b).borderTopColor')
        page.locator(selector).hover()
        frame = measure_border(page, selector, expected_token)
        page.mouse.move(0, 0)
        page.wait_for_function('''arg => getComputedStyle(document.querySelector(arg.selector)).borderTopColor === arg.idle''',
          arg={'selector':selector, 'idle':idle})
        page.locator('[data-states-probe]').evaluate('b => b.remove()')
        values.append({'class':cls, 'scope':scope, 'idleBorder':idle, 'hover':frame})
    return values

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='msedge')
        page = browser.new_page(viewport={'width':1200,'height':900})
        page.set_default_timeout(10000)
        page.on('pageerror', lambda error: result['errors'].append(str(error)))
        base = f'http://127.0.0.1:{server.server_port}/o/studio'
        page.goto(base + '?providers=1')
        header = '.shell-header-actions > button:last-child'
        page.locator(header).wait_for()
        page.locator(header).hover()
        neutral = measure_border(page, header, '--line-hover')
        assert neutral['border'] == neutral['expected'], neutral
        neutral_primary = measure_primary(page, '--line-hover')
        neutral_states = measure_states(page, '--line-hover')
        result['cases'].append({'agent':None,'header':neutral,'primary':neutral_primary,'states':neutral_states})
        page.goto(base + '?providers=1&view=attention')
        page.locator('.attn-agents-toggle').wait_for()
        for agent, provider in [('coordinator','claude'),('worker-a','openai'),('worker-g','google'),('worker-r','openrouter')]:
            toggle = page.locator('.attn-agents-toggle')
            if toggle.get_attribute('aria-expanded') != 'true':
                toggle.click()
            page.locator(f'[data-attn-agent="{agent}"]').click()
            page.wait_for_function('(id) => document.querySelector(`[data-attn-agent="${id}"]`)?.getAttribute("aria-selected") === "true"', arg=agent)
            toggle.hover()
            drawer = measure_border(page, '.attn-agents-toggle', f'--prov-{provider}')
            assert drawer['border'] == drawer['expected'], drawer
            page.keyboard.press('Tab')
            toggle.focus()
            focus = page.evaluate(MEASURE, {'selector':'.attn-agents-toggle','token':f'--prov-{provider}'})
            assert focus['focusVisible'] and focus['outline'] == focus['expected'], focus
            page.locator(header).hover()
            global_control = measure_border(page, header, f'--prov-{provider}')
            assert global_control['border'] == global_control['expected'], global_control
            primary = measure_primary(page, f'--prov-{provider}')
            states = measure_states(page, f'--prov-{provider}')
            # Another agent's row retains its own provider in a body portal.
            other, other_provider = ('worker-a','openai') if agent != 'worker-a' else ('worker-g','google')
            if toggle.get_attribute('aria-expanded') != 'true':
                toggle.click()
            page.locator(f'[data-attn-agent="{other}"]').click(button='right')
            page.locator('.ctxmenu').wait_for()
            menu = page.evaluate('''token => {
              const root = document.querySelector('.ctxmenu'), probe = document.createElement('span');
              probe.style.color = 'var(--button-accent)'; root.append(probe);
              const actual = getComputedStyle(probe).color; probe.remove();
              probe.style.color = `var(${token})`; document.body.append(probe);
              const expected = getComputedStyle(probe).color; probe.remove(); return {actual,expected};
            }''', f'--prov-{other_provider}')
            assert menu['actual'] == menu['expected'], menu
            page.keyboard.press('Escape')
            result['cases'].append({'agent':agent,'drawer':drawer,'focus':focus,'header':global_control,'primary':primary,'states':states,'otherAgentMenu':menu})

        # Verify the same production danger selectors, without calling actions.
        page.evaluate('''() => { for (const cls of ['danger','cc-send stop','disk-del','kill-latch open','resume-all notyet']) {
          const b = document.createElement('button'); b.className = cls; b.textContent = cls;
          b.dataset.dangerProbe = cls; document.querySelector('.app').append(b);
        } }''')
        for cls in ['danger','cc-send stop','disk-del','kill-latch open','resume-all notyet']:
            selector = f'[data-danger-probe="{cls}"]'
            page.locator(selector).hover(force=True)
            danger = measure_border(page, selector, '--bad')
            assert danger['border'] == danger['expected'], danger
            result['cases'].append({'danger':cls,'style':danger})
        assert not result['errors'], result['errors']
        page.screenshot(path=str(OUT / 'provider-buttons.png'))
        browser.close()
finally:
    server.shutdown()
    provenance.write_result(OUT / 'colours.json', result)
print(json.dumps(result, indent=2))
