"""Extra viewport/accessibility checks for The Social World (768/1920, mobile sheets)."""
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots" / "m5"
BASE = "http://127.0.0.1:8000"
RUN = "run_cbc3031797"


def context(browser, width, height, theme="dark"):
    c = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    c.add_init_script(f"try{{localStorage.setItem('oasis-theme','{theme}')}}catch(e){{}}")
    return c


CONTRAST_JS = """
() => {
  function lum(c) {
    const v = c.map(x => { x /= 255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
    return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2];
  }
  function parse(s) {
    const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map(Number); return [p[0],p[1],p[2],p[3] ?? 1];
  }
  const out = [];
  document.querySelectorAll('.btn-primary').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color), bg = parse(cs.backgroundColor);
    if (!fg || !bg || bg[3] < 0.5) return;
    const L1 = lum(fg) + 0.05, L2 = lum(bg) + 0.05;
    out.push({ text: (el.textContent || '').trim().slice(0, 40),
               ratio: Math.round((Math.max(L1,L2)/Math.min(L1,L2))*100)/100 });
  });
  return out;
}
"""

OVERFLOW_JS = "() => ({ w: document.documentElement.scrollWidth, v: window.innerWidth })"


def main() -> None:
    with sync_playwright() as p:
        b = p.chromium.launch()
        for width, height in ((1920, 1080), (768, 1024)):
            c = context(b, width, height)
            page = c.new_page()
            page.goto(f"{BASE}/#/simulations", wait_until="domcontentloaded")
            page.wait_for_timeout(1600)
            page.screenshot(path=str(OUT / f"simulations_{width}_dark.png"))
            print(width, "sim overflow", page.evaluate(OVERFLOW_JS))
            print(width, "primary contrast", page.evaluate(CONTRAST_JS))
            page.goto(f"{BASE}/#/run/{RUN}", wait_until="domcontentloaded")
            page.wait_for_timeout(1700)
            page.screenshot(path=str(OUT / f"run_feed_{width}_dark.png"))
            print(width, "run overflow", page.evaluate(OVERFLOW_JS))
            c.close()

        for theme in ("dark", "light"):
            c = context(b, 390, 844, theme)
            page = c.new_page()
            for name, route in (("sources", "/#/documents"), ("settings", "/#/settings")):
                page.goto(f"{BASE}{route}", wait_until="domcontentloaded")
                page.wait_for_timeout(1400)
                page.screenshot(path=str(OUT / f"{name}_390_{theme}.png"), full_page=True)
                print(name, theme, "overflow", page.evaluate(OVERFLOW_JS))
            page.goto(f"{BASE}/#/run/{RUN}", wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            page.evaluate("document.querySelector('.post .cite')?.click()")
            page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / f"source_sheet_390_{theme}.png"))
            inside = page.evaluate("(() => { const d = document.querySelector('.drawer'); return !!(d && d.contains(document.activeElement)); })()")
            print(name, theme, "source drawer focus inside", inside)
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)
            print("drawer after Esc", page.locator(".drawer").count())
            page.get_by_role("button", name="Run details").click()
            page.wait_for_timeout(800)
            page.screenshot(path=str(OUT / f"run_details_390_{theme}.png"))
            c.close()

        # lower part of Findings (charts + report) on desktop
        c = context(b, 1440, 900)
        page = c.new_page()
        page.goto(f"{BASE}/#/run/{RUN}", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.locator(".tab", has_text="Findings").click()
        page.wait_for_timeout(1200)
        page.evaluate("""() => {
          const els = [...document.querySelectorAll('.overflow-y-auto')];
          const el = els[els.length - 1];
          if (el) el.scrollTop = 820;
        }""")
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "run_findings_lower_1440_dark.png"))
        c.close()

        b.close()
        print("view checks written")


if __name__ == "__main__":
    main()
