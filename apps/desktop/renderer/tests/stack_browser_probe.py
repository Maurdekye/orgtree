import json
from pathlib import Path
from playwright.sync_api import sync_playwright

CSS = Path(__file__).parents[1] / "src" / "styles.css"
HTML = """<!doctype html><style>{}</style>
<div class=overlay id=pin><div class=settings style='position:absolute;left:20px;top:20px;width:220px;height:160px'><button id=pinbtn style='position:absolute;inset:0'>pinned</button></div></div>
<div class=overlay id=plain><div class=settings style='position:absolute;left:20px;top:20px;width:220px;height:160px'><button id=plainbtn style='position:absolute;inset:0'>plain</button></div></div>
<div class=modalpin-over id=nested style='display:none'><div class=overlay><div class=settings style='position:absolute;left:20px;top:20px;width:220px;height:160px'><button id=nestedbtn style='position:absolute;inset:0'>nested</button></div></div></div>"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 800, "height": 600})
    page.set_content(HTML.format(CSS.read_text(encoding="utf-8")))
    page.eval_on_selector("#pin", "e => e.classList.add('overlay-pinned')")
    page.eval_on_selector("#pin", "e => e.style.zIndex = '21'")
    result = page.evaluate("""() => {
      window.plainClicks = 0;
      document.querySelector('#plainbtn').onclick = () => window.plainClicks++;
      return {plainZ:getComputedStyle(document.querySelector('#plain')).zIndex,
              pinZ:getComputedStyle(document.querySelector('#pin')).zIndex};
    }""")
    page.mouse.click(40, 40)
    result["first"] = page.evaluate("""() => ({target:document.elementFromPoint(40,40).id,
                                                   clicks:window.plainClicks})""")
    page.eval_on_selector("#pin", "e => e.style.zIndex = '29'")
    page.mouse.click(40, 40)
    result["raised"] = page.evaluate("""() => ({target:document.elementFromPoint(40,40).id,
                                                    clicks:window.plainClicks,
                                                    pinZ:getComputedStyle(document.querySelector('#pin')).zIndex})""")
    nested = page.evaluate("""() => {
      document.querySelector('#nested').style.display = 'block';
      window.nestedClicks = 0;
      document.querySelector('#nestedbtn').onclick = () => window.nestedClicks++;
      return {nestedZ:getComputedStyle(document.querySelector('#nested .overlay')).zIndex,
              plainZ:getComputedStyle(document.querySelector('#plain')).zIndex,
              pinZ:getComputedStyle(document.querySelector('#pin')).zIndex};
    }""")
    page.mouse.click(40, 40)
    nested.update(page.evaluate("""() => ({nestedTarget:document.elementFromPoint(40,40).id,
                                             nestedClicks:window.nestedClicks})"""))
    result["nested"] = nested
    page.evaluate("document.querySelector('#nested').remove()")
    old = page.evaluate("""() => {
      document.querySelector('#plain').style.zIndex = '20';
      return {target:document.elementFromPoint(40,40).id,
              plainZ:getComputedStyle(document.querySelector('#plain')).zIndex};
    }""")
    assert old["target"] == "pinbtn" and old["plainZ"] == "20", old
    result["oldZControl"] = old
    page.eval_on_selector("#plain", "e => e.style.zIndex = '30'")
    result["restored"] = page.evaluate("""() => ({plainZ:getComputedStyle(document.querySelector('#plain')).zIndex,
                                                     pinZ:getComputedStyle(document.querySelector('#pin')).zIndex})""")
    assert result["first"] == {"target": "plainbtn", "clicks": 1}, result
    assert result["raised"] == {"target": "plainbtn", "clicks": 2, "pinZ": "29"}, result
    assert result["nested"] == {"nestedTarget": "nestedbtn", "nestedClicks": 1,
                                 "nestedZ": "31", "plainZ": "30", "pinZ": "29"}, result
    assert result["restored"] == {"plainZ": "30", "pinZ": "29"}, result
    page.screenshot(path=str(Path(__file__).parents[2] / "stack-browser-evidence.png"))
    browser.close()
print(json.dumps(result, sort_keys=True))
