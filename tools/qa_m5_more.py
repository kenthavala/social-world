"""Additional M5 QA: drawers, compare, sources, settings and wizard."""
from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "screenshots" / "m5"
BASE = "http://127.0.0.1:8000"
RUN = "run_cdb7407a2a"
OTHER = "run_a5d78ff597"
BIG = "run_5b8dc0a6ed"


def ctx(browser, width, height, theme):
    c = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1)
    c.add_init_script(f"try{{localStorage.setItem('oasis-theme','{theme}')}}catch(e){{}}")
    return c


def main() -> None:
    with sync_playwright() as p:
        b = p.chromium.launch()
        c = ctx(b, 1440, 900, "dark")
        page = c.new_page()
        page.goto(f"{BASE}/#/run/{RUN}", wait_until="domcontentloaded")
        page.wait_for_timeout(1600)
        page.get_by_role("button", name="Run details").click()
        page.wait_for_timeout(900)
        page.screenshot(path=str(OUT / "run_details_1440_dark.png"))
        c.close()

        c = ctx(b, 1440, 900, "dark")
        page = c.new_page()
        page.goto(f"{BASE}/#/compare?a={RUN}&b={OTHER}", wait_until="domcontentloaded")
        page.wait_for_timeout(1800)
        page.screenshot(path=str(OUT / "compare_1440_dark.png"), full_page=True)
        c.close()

        c = ctx(b, 390, 844, "dark")
        page = c.new_page()
        page.goto(f"{BASE}/#/compare?a={RUN}&b={OTHER}", wait_until="domcontentloaded")
        page.wait_for_timeout(1600)
        page.screenshot(path=str(OUT / "compare_390_dark.png"), full_page=True)
        c.close()

        for theme in ("dark", "light"):
            c = ctx(b, 1440, 900, theme)
            page = c.new_page()
            page.goto(f"{BASE}/#/documents", wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / f"sources_1440_{theme}.png"))
            page.goto(f"{BASE}/#/settings", wait_until="domcontentloaded")
            page.wait_for_timeout(1500)
            page.screenshot(path=str(OUT / f"settings_1440_{theme}.png"), full_page=True)
            c.close()

        c = ctx(b, 1440, 900, "dark")
        page = c.new_page()
        page.goto(f"{BASE}/#/new", wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT / "wizard_source_1440_dark.png"))
        chip = page.locator("button.chip", has_text="harbour").first
        if chip.count() > 0:
            chip.click()
            page.wait_for_timeout(1000)
            next_btn = page.get_by_role("button", name="Review the scenario")
            if next_btn.count() > 0:
                next_btn.click()
                page.wait_for_timeout(900)
                page.screenshot(path=str(OUT / "wizard_scenario_1440_dark.png"), full_page=True)
        c.close()

        c = ctx(b, 1440, 900, "dark")
        page = c.new_page()
        page.goto(f"{BASE}/#/run/{OTHER}", wait_until="domcontentloaded")
        page.wait_for_timeout(1400)
        page.locator(".tab", has_text="Findings").click()
        page.wait_for_timeout(1000)
        essay = page.locator(".panel.generated")
        if essay.count() > 0:
            essay.first.screenshot(path=str(OUT / "run_essay_1440_dark.png"))
        c.close()

        c = ctx(b, 1440, 900, "dark")
        page = c.new_page()
        page.goto(f"{BASE}/#/run/{BIG}", wait_until="domcontentloaded")
        page.wait_for_timeout(1400)
        page.locator(".tab", has_text="Connections").click()
        page.wait_for_timeout(2200)
        page.screenshot(path=str(OUT / "run_connections_40_1440_dark.png"))
        c.close()

        b.close()
        print("more screenshots written")


if __name__ == "__main__":
    main()
