"""Real Chromium, real presentation API responses, no live service or data.

Build the fixture first: node tests/htmlmockups_browser_bundle.mjs
Then: python tests/htmlmockups_browser_probe.py --out-dir <evidence folder>
The browser's HTTP transport is intercepted and forwarded to an isolated
FastAPI TestClient. Any forbidden request is counted, never sent to a real API.
An unprotected positive control proves the counter detects outgoing requests.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import quote, urlsplit

TMP = Path(tempfile.mkdtemp(prefix="orgtree-mockup-browser-"))
DATA = TMP / "data"
DATA.mkdir()
os.environ["ORGTREE_DATA"] = str(DATA)
os.environ.pop("ORGTREE_WARM", None)
(DATA / "defaults.json").write_text('{"net_hub_address":"http://127.0.0.1:9"}', encoding="utf-8")
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from fastapi.testclient import TestClient
from orgtree import api, store, supervisor
from orgtree.ledger import USER
from playwright.sync_api import sync_playwright

assert Path(store.DATA_ROOT).resolve() == DATA.resolve(), store.DATA_ROOT
supervisor.send_message = lambda *a, **kw: {"accepted": True, "queued": 0}
client = TestClient(api.app)
ORIGIN = "http://127.0.0.1:59991"
PAYLOAD = r'''<!doctype html><html><head><style>
body{font:16px system-ui;background:#f4f7fb;color:#18263a;padding:30px}
button{padding:12px;border-radius:8px;background:#275dcc;color:white;border:0}
</style></head><body>
<h1>Interactive prototype</h1><button id="increment" onclick="this.textContent=String(++window.count)">0</button>
<form id="interactive" onsubmit="event.preventDefault();document.querySelector('#form-result').textContent='submitted'">
<input value="local draft"><button>Submit locally</button></form><p id="form-result"></p>
<form id="forbidden" action="http://127.0.0.1:59991/api/forbidden-form" method="post"></form>
</iframe><script>
window.count=0;window.MOCKUP_SCRIPT_RAN=true;window.results={};
for(const [name,fn] of Object.entries({
parent:()=>parent.document.body.innerHTML,top:()=>top.document.body.innerHTML,
cookie:()=>document.cookie,storage:()=>localStorage.getItem('operator-secret')
})){try{results[name]=fn()}catch(e){results[name]='blocked'}}
fetch('http://127.0.0.1:59991/api/forbidden-fetch',{method:'POST',credentials:'include',body:'attempt'})
 .then(()=>results.fetch='allowed').catch(()=>results.fetch='blocked');
</script></body></html>'''


def run(out: Path) -> None:
    bundle = ROOT / "frontend/node_modules/.orgtree-mockup-browser/probe.js"
    if not bundle.is_file():
        raise RuntimeError("INERT: build htmlmockups_browser_bundle.mjs before this probe")
    out.mkdir(parents=True, exist_ok=True)
    org = store.create_org("mockup-browser", [])
    org.hire(USER, None, "haiku", 0, "designer")
    store.save_org(org)
    scratch = Path(supervisor.scratch_dir("mockup-browser", "designer"))
    scratch.mkdir(parents=True, exist_ok=True)
    source = scratch / "prototype.html"
    source.write_text(PAYLOAD, encoding="utf-8")
    published = client.post("/api/agent", json={"org": "mockup-browser", "node": "designer",
        "tool": "orgtree_present", "args": {"title": "Interactive prototype", "path": str(source)}})
    assert published.status_code == 200, published.text
    did = published.json()["presented"]
    preview = f"/api/orgs/mockup-browser/documents/{did}/mockup"
    saved = next(d for d in store.load_org("mockup-browser").d["documents"] if d["id"] == did)
    download_path = "/api/orgs/mockup-browser/nodes/designer/file"
    download_url = download_path + "?path=" + quote(saved["file"])
    download_response = client.get(download_url)
    assert download_response.status_code == 200, download_response.text
    assert download_response.headers["content-disposition"].startswith("attachment;"), download_response.headers
    response = client.get(preview)
    assert response.status_code == 200, response.text
    (out / "response-headers.json").write_text(json.dumps(dict(response.headers), indent=2), encoding="utf-8")
    css = (ROOT / "frontend/src/styles.css").read_text(encoding="utf-8")
    forbidden: list[str] = []
    transport: list[str] = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1100, "height": 750})
        context.add_cookies([{"name": "operator-secret", "value": "private", "url": ORIGIN}])

        def route_request(route):
            request = route.request
            transport.append(request.url)
            path = urlsplit(request.url).path
            if path.startswith("/api/forbidden") or urlsplit(request.url).netloc != "127.0.0.1:59991":
                forbidden.append(request.url)
                route.fulfill(status=200, body="recorded", content_type="text/plain")
            elif path in {preview, download_path}:
                result = client.get(path + ("?" + urlsplit(request.url).query if urlsplit(request.url).query else ""))
                headers = {k: v for k, v in result.headers.items() if k.lower() not in {"content-length", "content-encoding"}}
                route.fulfill(status=result.status_code, body=result.content, headers=headers)
            elif path == "/probe.js":
                route.fulfill(body=bundle.read_text(encoding="utf-8"), content_type="text/javascript")
            elif path == "/unsafe-control":
                route.fulfill(body=PAYLOAD, content_type="text/html")
            elif path in {"/", "/k/visitor/"}:
                route.fulfill(body=f'<style>{css}</style><div id="app"></div><script type="module" src="/probe.js"></script>', content_type="text/html")
            else:
                forbidden.append(request.url)
                route.fulfill(status=404, body="unexpected request")

        context.route("**/*", route_request)
        app = context.new_page()
        app.goto(f"{ORIGIN}/?id={did}&org=mockup-browser")
        app.evaluate("localStorage.setItem('operator-secret','private')")
        with app.expect_popup() as opened:
            app.locator("a.doc-badge").click()
        popup = opened.value
        popup.wait_for_load_state()
        assert popup.url == ORIGIN + preview
        assert popup.evaluate("window.opener === null")
        assert app.url.startswith(ORIGIN + "/?id=")
        assert popup.evaluate("typeof window.MOCKUP_SCRIPT_RAN") == "undefined", "HTML escaped into trusted wrapper"

        def assert_isolated(page):
            frame = page.frame_locator("iframe")
            frame.locator("#increment").click()
            assert frame.locator("#increment").inner_text() == "1"
            frame.locator("#interactive button").click()
            assert frame.locator("#form-result").inner_text() == "submitted"
            child = next(f for f in page.frames if f != page.main_frame)
            child.wait_for_function("results.fetch === 'blocked'")
            facts = child.evaluate("({results,href:location.href,base:document.baseURI,referrer:document.referrer})")
            assert facts["results"] == {key: "blocked" for key in ["parent", "top", "cookie", "storage", "fetch"]}, facts
            assert facts["href"] == "about:srcdoc" and facts["base"] == "about:blank", facts
            assert facts["referrer"] == "", facts
            assert forbidden == [], forbidden
            return child

        child = assert_isolated(popup)
        popup.screenshot(path=str(out / "mockup-new-tab.png"))
        app.screenshot(path=str(out / "presentation-cards.png"))
        # Direct URL entry uses the identical protected response.
        direct = context.new_page()
        direct.goto(ORIGIN + preview)
        assert_isolated(direct)
        # Browser automation evaluates outside the page's script-src eval gate.
        attacks = [
            "() => { document.querySelector('#forbidden').submit() }",
            "() => { location.href='http://127.0.0.1:59991/api/forbidden-navigation' }",
            "() => { try { top.location.href='http://127.0.0.1:59991/api/forbidden-top' } catch(e) {} }",
            "() => { window.open('http://127.0.0.1:59991/api/forbidden-popup') }",
        ]
        for attack in attacks:
            direct.goto(ORIGIN + preview)
            child = next(f for f in direct.frames if f != direct.main_frame)
            child.wait_for_function("window.MOCKUP_SCRIPT_RAN")
            child.evaluate(attack)
            direct.wait_for_timeout(100)
            assert direct.url == ORIGIN + preview
            assert forbidden == [], forbidden
            assert len(context.pages) == 3, "mockup opened another window"
        # The existing alternate artifact URL must download, never render
        # raw executable HTML on the application origin. No download attr:
        # the actual server Content-Disposition is what protects this path.
        app.evaluate("url => { const a=document.createElement('a'); a.id='raw-artifact'; a.href=url; a.textContent='Download'; document.body.append(a) }", ORIGIN + download_url)
        with app.expect_download() as received:
            app.locator("#raw-artifact").click()
        assert Path(received.value.path()).read_text(encoding="utf-8") == PAYLOAD
        assert app.evaluate("typeof window.MOCKUP_SCRIPT_RAN") == "undefined"
        assert forbidden == [], forbidden
        # Unsupported visitor context never offers an active mockup URL.
        app.goto(f"{ORIGIN}/k/visitor/?id={did}&org=mockup-browser")
        app.locator(".doc-badge[aria-disabled=true]").wait_for()
        assert app.locator('a[href$="/mockup"]').count() == 0
        # Positive control: same hostile payload without protection must reach
        # the same request counter, and can read the same stored cookie.
        control = context.new_page()
        control.goto(ORIGIN + "/unsafe-control")
        control.wait_for_function("results.fetch === 'allowed'")
        assert any("forbidden-fetch" in u for u in forbidden), forbidden
        assert "operator-secret=private" in control.evaluate("document.cookie")
        browser.close()
    (out / "probe-results.json").write_text(json.dumps({"new_tab": True, "direct_entry": True,
        "interactions": True, "isolated": True, "visitor_unavailable": True,
        "alternate_artifact_download_only": True,
        "positive_control_requests": forbidden, "transport": transport}, indent=2), encoding="utf-8")
    print("PASS: real card new tab, inline interactions, direct access, isolation, visitor UI and outgoing-request positive control")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=Path, required=True)
    run(parser.parse_args().out_dir)
