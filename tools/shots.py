"""Playwright screenshot helper for OASIS-Lite (exact viewports, HTTP only).

Usage:
  python tools/shots.py <series> <out_dir> [run_url_path]

series: "baseline" (M1 UI) or any label; writes PNGs at 1440x900, 1280x720, 1920x1080, 390x844.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8000"
SIZES = [(1440, 900), (1280, 720), (1920, 1080), (390, 844)]


def main() -> None:
    series = sys.argv[1] if len(sys.argv) > 1 else "baseline"
    out_dir = Path(sys.argv[2] if len(sys.argv) > 2 else f"docs/screenshots/{series}")
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = sys.argv[3:] or ["/"]

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for (w, h) in SIZES:
            ctx = browser.new_context(viewport={"width": w, "height": h},
                                      device_scale_factor=1)
            page = ctx.new_page()
            for i, path in enumerate(pages):
                url = path if path.startswith("http") else BASE + path
                page.goto(url, wait_until="networkidle", timeout=20000)
                page.wait_for_timeout(700)
                name = f"{series}_{w}x{h}" + (f"_{i}" if len(pages) > 1 else "") + ".png"
                page.screenshot(path=str(out_dir / name), full_page=(h < 500))
                print(f"wrote {out_dir / name}")
            ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
