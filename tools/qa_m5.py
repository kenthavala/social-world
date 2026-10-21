"""Capture the M5 product screens for visual QA (dark/light, 1440/390/1280)."""
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots" / "m5"
OUT.mkdir(parents=True, exist_ok=True)
BASE = "http://127.0.0.1:8000"
RUN = "run_cdb7407a2a"


def context(browser, width: int, height: int, theme: str):
    ctx = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    ctx.add_init_script(f"try{{localStorage.setItem('oasis-theme','{theme}')}}catch(e){{}}")
    return ctx


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        errors: list[str] = []
        for theme in ("dark", "light"):
            ctx = context(browser, 1440, 900, theme)
            page = ctx.new_page()
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.goto(f"{BASE}/#/simulations", wait_until="domcontentloaded")
            page.wait_for_timeout(1800)
            page.screenshot(path=str(OUT / f"simulations_1440_{theme}.png"), full_page=True)
            page.goto(f"{BASE}/#/run/{RUN}", wait_until="domcontentloaded")
            page.wait_for_timeout(1800)
            page.screenshot(path=str(OUT / f"run_feed_1440_{theme}.png"))
            page.locator(".tab", has_text="Findings").click()
            page.wait_for_timeout(1200)
            page.screenshot(path=str(OUT / f"run_findings_1440_{theme}.png"), full_page=True)
            page.locator(".tab", has_text="Connections").click()
            page.wait_for_timeout(1600)
            page.screenshot(path=str(OUT / f"run_connections_1440_{theme}.png"))
            page.locator(".tab", has_text="Feed").click()
            page.wait_for_timeout(600)
            page.evaluate("document.querySelector('.post .cite')?.click()")
            page.wait_for_timeout(900)
            page.screenshot(path=str(OUT / f"run_source_1440_{theme}.png"))
            ctx.close()

        # collapsed rail at 1280
        ctx = context(browser, 1280, 720, "dark")
        page = ctx.new_page()
        page.goto(f"{BASE}/#/simulations", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / "simulations_1280_dark.png"))
        ctx.close()

        # mobile
        for theme in ("dark", "light"):
            ctx = context(browser, 390, 844, theme)
            page = ctx.new_page()
            page.goto(f"{BASE}/#/simulations", wait_until="domcontentloaded")
            page.wait_for_timeout(1600)
            page.screenshot(path=str(OUT / f"simulations_390_{theme}.png"), full_page=True)
            page.goto(f"{BASE}/#/run/{RUN}", wait_until="domcontentloaded")
            page.wait_for_timeout(1700)
            page.screenshot(path=str(OUT / f"run_feed_390_{theme}.png"))
            page.locator("nav[aria-label='Run sections'] button", has_text="Findings").click()
            page.wait_for_timeout(1000)
            page.screenshot(path=str(OUT / f"run_findings_390_{theme}.png"), full_page=True)
            ctx.close()

        browser.close()
        print("screenshots written")
        if errors:
            print("CONSOLE ERRORS:")
            for e in errors[:20]:
                print(" -", e)


if __name__ == "__main__":
    main()
