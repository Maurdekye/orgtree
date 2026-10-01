"""attnqueue_probe.py — the Attention view's entries measured against the
surfaces they are borrowed from, in a real browser (docket
v3-attention-view-show-the-full-ticket-detail-vi, user 2026-09-29: "the list
elements should each look identical to how they each look in their respective
lists, and the bodies should look identical to how they look in their
respective details").

  R. Each Attention row has the computed style of the same row at home: the
     ticket row as in the docket, the urgent mail and the question as in the
     inbox (font, weight, colour, background, padding, borders, height, and
     the same for its two lines).
  P. Each Attention body likewise: the ticket pane as in the docket, the mail
     and question panes as in the inbox.
  T. Dismissing a ticket: time from the click to the row leaving the list,
     against a STUBBED server that holds the POST and every /work-items GET
     for fixed delays (reported, not asserted against a real engine).

    cd apps/desktop/renderer
    python tests/attnqueue_probe.py <outdir> [--timing-only] [--page <entry.tsx>]

Requires playwright with the msedge channel. Exit status is 0 only when
every R/P check passes (T is a measurement).
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = pathlib.Path(__file__).resolve().parent
FRONTEND = HERE.parent
REPO = FRONTEND.parents[2]

# team rule: every test module and probe proves which checkout it runs from
# (this one drives the renderer bundle built from FRONTEND, not the engine,
# but the receipt still pins the checkout the measurement belongs to)
sys.path.insert(0, str(REPO / "tools"))
from assert_repo_import import assert_repo_import  # noqa: E402
PROVENANCE = assert_repo_import(REPO)

from playwright.sync_api import sync_playwright  # noqa: E402
VP_W, VP_H = 1600, 900
POST_MS, GET_MS = 200, 300

# what "looks identical" is measured by: the box and type of an element and
# of its first two lines (the rows' .l1/.l2), never its width, which is the
# host's to decide
STYLE = """(sel) => { const e = document.querySelector(sel); if (!e) return null;
  const pick = (el) => { if (!el) return null; const s = getComputedStyle(el);
    return {fontSize: s.fontSize, fontWeight: s.fontWeight, fontFamily: s.fontFamily,
      color: s.color, background: s.backgroundColor, padding: s.padding,
      borderTop: s.borderTop, borderBottom: s.borderBottom, borderLeft: s.borderLeft,
      lineHeight: s.lineHeight, height: Math.round(el.getBoundingClientRect().height)} };
  return {self: pick(e), l1: pick(e.querySelector(':scope > .l1')),
          l2: pick(e.querySelector(':scope > .l2'))} }"""

PANE = """(sel) => { const root = document.querySelector(sel); if (!root) return null;
  const out = {};
  for (const c of ['.mailer-head', '.urgent-why', '.mailer-body', '.docket-pane-head',
                   '.docket-pane-sub', '.askcard', '.mail-reply']) {
    const el = root.querySelector(c); if (!el) continue;
    const s = getComputedStyle(el);
    out[c] = {fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color,
      padding: s.padding, margin: s.margin, background: s.backgroundColor};
  }
  return out }"""

DISMISS = """async () => {
  const cell = document.querySelector('[data-attn-row="ticket:cutover"]');
  if (!cell) return {error: 'no ticket row'};
  (cell.querySelector('.mailrow') || cell).click();
  await new Promise(r => setTimeout(r, 900));
  const btn = [...document.querySelectorAll('[data-attn-detail="ticket"] button, .attn-detail button')]
    .find(b => /Dismiss/.test(b.textContent || ''));
  if (!btn) return {error: 'no dismiss button'};
  const t0 = performance.now();
  const gone = new Promise(resolve => {
    const check = () => !document.querySelector('[data-attn-row="ticket:cutover"]');
    if (check()) return resolve(performance.now() - t0);
    const mo = new MutationObserver(() => { if (check()) { mo.disconnect(); resolve(performance.now() - t0) } });
    mo.observe(document.body, {subtree: true, childList: true});
    setTimeout(() => { mo.disconnect(); resolve(null) }, 15000);
  });
  btn.click();
  return {ms: await gone} }"""


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = pathlib.Path(args[0] if args else "attnqueue-out").resolve()
    timing_only = "--timing-only" in sys.argv
    entry = "attnqueue-probe.tsx"
    if "--page" in sys.argv:
        entry = sys.argv[sys.argv.index("--page") + 1]
    build = out / "build"
    subprocess.run(["node", str(HERE / "attentionlayout_build.mjs"), str(build), entry],
                   check=True, cwd=str(FRONTEND))
    url = (build / "probe.html").as_uri()
    res: dict = {"stub_ms": {"dismiss_post": POST_MS, "work_items_get": GET_MS}}
    checks: dict[str, bool] = {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge")
        ctx = browser.new_context(viewport={"width": VP_W, "height": VP_H})

        def scene(name: str):
            page = ctx.new_page()
            page.on("pageerror", lambda e: res.setdefault("pageerrors", []).append(f"{name}: {e}"))
            page.goto(url + "#" + name)
            page.wait_for_timeout(1800)
            return page

        # ---- T: dismiss timing, five runs each on a fresh page
        runs = []
        for _ in range(5):
            p = scene(f"attention-{POST_MS}-{GET_MS}")
            runs.append(p.evaluate(DISMISS))
            p.close()
        res["dismiss_runs"] = runs
        ms = [r.get("ms") for r in runs if isinstance(r, dict)]
        res["dismiss_ms"] = ms
        if timing_only:
            browser.close()
            (out / "result.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
            print(json.dumps(res, indent=2))
            return 0

        # ---- the Attention view: rows unselected, then each body
        p = scene("attention")
        att = {
            "ticket_row": p.evaluate(STYLE, '[data-attn-row="ticket:cutover"] .mailrow'),
            "question_row": p.evaluate(STYLE, '[data-attn-row="question:q1"] .mailrow'),
        }
        p.screenshot(path=str(out / "attention.png"))
        p.click('[data-attn-row="ticket:cutover"] .mailrow')
        p.wait_for_timeout(600)
        att["ticket_pane"] = p.evaluate(PANE, ".attn-mread")
        p.screenshot(path=str(out / "attention-ticket.png"))
        # each entry compared SELECTED, as the inbox shows it when opened
        p.click('[data-attn-row="question:q1"] .mailrow')
        p.wait_for_timeout(600)
        att["question_row_selected"] = p.evaluate(STYLE, '[data-attn-row="question:q1"] .mailrow')
        att["question_pane"] = p.evaluate(PANE, ".attn-mread")
        p.screenshot(path=str(out / "attention-question.png"))
        p.click('[data-attn-row="mail:m1"] .mailrow')
        p.wait_for_timeout(600)
        att["mail_row_selected"] = p.evaluate(STYLE, '[data-attn-row="mail:m1"] .mailrow')
        att["mail_pane"] = p.evaluate(PANE, ".attn-mread")
        p.screenshot(path=str(out / "attention-mail.png"))
        att["header_row"] = p.evaluate(
            "() => !!document.querySelector('.attn-head, .attn-counts')")
        p.close()

        # ---- the docket
        p = scene("docket")
        home = {"ticket_row": p.evaluate(STYLE, ".docket-modal .docket-row.attention")}
        p.click(".docket-modal .docket-row.attention")
        p.wait_for_timeout(600)
        home["ticket_pane"] = p.evaluate(PANE, ".docket-modal .mailer-read")
        p.screenshot(path=str(out / "docket.png"))
        p.close()

        # ---- the inbox: it opens with its oldest unread MAIL selected (asks
        # are excluded from that rule), the question unselected
        p = scene("inbox")
        home["question_row"] = p.evaluate(STYLE, ".mailer-list .mailrow.ask")
        home["mail_row_selected"] = p.evaluate(STYLE, ".mailer-list .mailrow.urgent")
        home["mail_pane"] = p.evaluate(PANE, ".mailer-read")
        p.screenshot(path=str(out / "inbox.png"))
        p.click(".mailer-list .mailrow.ask")
        p.wait_for_timeout(600)
        home["question_row_selected"] = p.evaluate(STYLE, ".mailer-list .mailrow.ask")
        home["question_pane"] = p.evaluate(PANE, ".mailer-read")
        p.screenshot(path=str(out / "inbox-question.png"))
        p.close()
        browser.close()

    res["attention"], res["home"] = att, home
    diffs = {}
    for key in ("ticket_row", "question_row", "mail_row_selected", "question_row_selected"):
        a, h = att.get(key), home.get(key)
        d = {} if a and h else {"missing": {"attention": bool(a), "home": bool(h)}}
        for part in ("self", "l1", "l2"):
            for prop, val in ((a or {}).get(part) or {}).items():
                other = ((h or {}).get(part) or {}).get(prop)
                if val != other:
                    d[f"{part}.{prop}"] = {"attention": val, "home": other}
        diffs[key] = d
        checks[f"R_{key}_identical"] = not d
    for key in ("ticket_pane", "mail_pane", "question_pane"):
        a, h = att.get(key) or {}, home.get(key) or {}
        d = {c: {"attention": a.get(c), "home": h.get(c)}
             for c in sorted(set(a) | set(h)) if a.get(c) != h.get(c)}
        diffs[key] = d
        checks[f"P_{key}_identical"] = bool(a) and not d
    checks["H_no_header_row"] = not att.get("header_row")
    res["diffs"], res["checks"] = diffs, checks
    (out / "result.json").write_text(json.dumps(res, indent=2), encoding="utf-8")
    print(json.dumps({"checks": checks, "diffs": diffs, "dismiss_ms": res["dismiss_ms"],
                      "pageerrors": res.get("pageerrors")}, indent=2))
    failed = [k for k, v in checks.items() if not v]
    print("FAILED: " + ", ".join(failed) if failed else "ALL CHECKS PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
