"""Computed provider colors on actual mounted cards and an independent desk.

Use --expect-missing-scope on the original source as the negative control.
Only fixture fetch responses are used; no backend or provider calls.
"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from playwright.sync_api import sync_playwright

here = Path(__file__).resolve().parent
out = Path(tempfile.mkdtemp(prefix='orgtree-provider-theme-'))
subprocess.run(['node', str(here / 'provider-theme-build.mjs'), str(out)], check=True)
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width': 1150, 'height': 750})
    page.goto((out / 'probe.html').as_uri())
    page.wait_for_selector('#standalone .desk-body')
    reports = []
    for theme in ['orgtree', 'codex']:
        page.evaluate('(t) => window.setProbeTheme(t)', theme)
        reports.append(page.evaluate('''() => {
          const root = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
          const cards = [...document.querySelectorAll('#cards .sq')].map(el => ({
            tier: el.className.match(/tier-([^ ]+)/)[1],
            accent: getComputedStyle(el).getPropertyValue('--accent').trim(),
            stripe: getComputedStyle(el).borderTopColor,
          }));
          const desk = document.querySelector('#standalone .desk-body');
          return { root, cards, desk: getComputedStyle(desk).getPropertyValue('--accent').trim() };
        }'''))
    failures = []
    for report in reports:
        for card in report['cards'][:4]:
            if card['accent'].lower() != '#d97757':
                failures.append(f"{card['tier']} inherited {card['accent']}")
        if report['desk'].lower() != '#d97757':
            failures.append(f"standalone desk inherited {report['desk']}")
    assert reports[0]['root'] == '#b6bdc8', 'neutral application control must be active'
    assert reports[1]['root'] == '#22c4bd', 'theme change control must actually run'
    assert len({c['stripe'] for c in reports[0]['cards'][:4]}) == 4, 'model stripes stay distinct'
    assert reports[0]['cards'][4]['accent'] == reports[1]['cards'][4]['accent'], 'Codex stays scoped'
    if '--expect-missing-scope' in sys.argv:
        assert len(failures) == 10, f'baseline must reproduce all missing Claude scopes: {failures}'
    else:
        assert not failures, failures
    page.evaluate("window.setProbeTheme('orgtree')")
    page.screenshot(path=str(out / 'provider-theme.png'))
    browser.close()
print(json.dumps({'reports': reports, 'baseline_failures': failures, 'artifacts': str(out)}, indent=2))
