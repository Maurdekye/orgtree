"""Real-browser contract for Codex chrome's two independent color channels.

    python -B tests/codex_theme_probe.py
    python -B tests/codex_theme_probe.py --expect-fail

The provider chrome is #22c4bd teal, including the agent-tray context wheel,
while the model-tier badge and top stripe remain tier-colored (Sol = reddish
orange). The known-negative control restores Claude terracotta as the provider
accent and must be detected.
"""
import argparse
import pathlib

from playwright.sync_api import sync_playwright


CSS = pathlib.Path(__file__).resolve().parents[1] / "src" / "styles.css"
PROVIDER = "rgb(34, 196, 189)"
SOL = "rgb(255, 138, 61)"
AUDIENCE = "rgb(217, 119, 87)"
CONTROL = """
.sq.prov-openai { --accent: #d97757; --accent-soft: rgba(217,119,87,.16); }
.sq.prov-openai.desk { border-color: #d97757; }
.sq.prov-openai.desk.tier-sol { border-top-color: var(--tier-sol); }
.tray-row.prov-openai { --accent: #d97757; }
"""

HTML = """
<div class="sq prov-openai desk tier-sol asking">
  <span class="tier t-sol">S</span>
  <span class="working">working</span>
  <svg class="ctxwheel"><circle class="fill" /></svg>
  <div class="cc-composer"><textarea></textarea></div>
  <button class="primary">send</button>
  <button class="cc-eff set">high</button>
  <span class="badge free aud-user">user</span>
  <div class="askcard"><button class="ask-submit">answer</button></div>
</div>
<svg><path class="edge aud-line from-user" /></svg>
<div class="sq draft prov-openai">
  <span class="draft-tag">uninitialized</span>
  <div class="draft-over"><div class="draft-inner">
    <div class="df-foot"><button class="primary">hire</button></div>
  </div></div>
</div>
<div class="tray-row prov-openai"><div class="tray-main">
  <svg class="ctxwheel" viewBox="0 0 16 16"><circle class="fill" /></svg>
</div></div>
"""


def measure(css: str) -> dict[str, str]:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page()
        page.set_content(f"<style>{css}</style>{HTML}")
        page.locator("textarea").focus()
        got = page.evaluate("""() => {
          const one = s => getComputedStyle(document.querySelector(s));
          const sq = one('.sq');
          return {
            top: sq.borderTopColor,
            side: sq.borderRightColor,
            tier: one('.tier').color,
            working: one('.working').color,
            wheel: one('.ctxwheel .fill').stroke,
            composer: one('.cc-composer').borderColor,
            send: one('button.primary').backgroundColor,
            effort: one('.cc-eff').borderColor,
            askAnimation: sq.animationName,
            askBorder: one('.askcard').borderColor,
            audienceTag: one('.badge.aud-user').color,
            audienceLine: one('.edge.aud-line.from-user').stroke,
            draftBorder: one('.sq.draft').borderRightColor,
            draftTag: one('.draft-tag').color,
            draftHire: one('.sq.draft button.primary').backgroundColor,
            trayWheel: one('.tray-row .ctxwheel .fill').stroke,
          };
        }""")
        browser.close()
        return got


def findings(got: dict[str, str]) -> list[str]:
    fail = []
    for key in ("side", "working", "wheel", "composer", "send", "effort"):
        if got[key] != PROVIDER:
            fail.append(f"{key} is {got[key]}, expected provider blue {PROVIDER}")
    for key in ("draftBorder", "draftTag", "draftHire"):
        if got[key] != PROVIDER:
            fail.append(f"{key} is {got[key]}, expected provider blue {PROVIDER}")
    if got["trayWheel"] != PROVIDER:
        fail.append(f"tray wheel is {got['trayWheel']}, expected provider blue {PROVIDER}")
    for key in ("top", "tier"):
        if got[key] != SOL:
            fail.append(f"{key} is {got[key]}, expected Sol tier color {SOL}")
    for key in ("audienceTag", "audienceLine"):
        if got[key] != AUDIENCE:
            fail.append(f"{key} is {got[key]}, expected user-audience orange {AUDIENCE}")
    if got["askAnimation"] != "askglow":
        fail.append("question aura lost its askglow animation")
    # The ask card is a blue/line mix, so it is intentionally not the solid
    # provider color. It must, however, differ from Claude's root accent.
    if got["askBorder"] == "rgb(217, 119, 87)":
        fail.append("question card fell back to Claude terracotta")
    return fail


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--expect-fail", action="store_true")
    args = ap.parse_args()
    css = CSS.read_text(encoding="utf-8") + (CONTROL if args.expect_fail else "")
    got = measure(css)
    fail = findings(got)
    if args.expect_fail:
        if not fail:
            print("CONTROL FAILED — restored Claude accent escaped detection")
            return 1
        print(f"CONTROL OK — restored Claude accent detected ({len(fail)} finding(s))")
        return 0
    if fail:
        print("\n".join("FAIL: " + x for x in fail))
        return 1
    print("OK — Codex desk, draft, and tray wheel are #22c4bd teal; Sol badge/top stripe stay tier orange; ask aura is provider-themed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
