"""QA screenshots for OASIS_SIM — every core page at the mandated viewports.

Usage:
  python tools/qa_shots.py [base_url] [out_dir]

Runs against a live server (http://127.0.0.1:8000 by default). It creates a fresh
mock run for the Live/RUNNING captures and uses the most-populated completed run
for Agents / Network / Events / Analysis / Log. Writes PNGs to docs/screenshots/final/.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else "docs/screenshots/final")
SIZES = [(1440, 900), (1280, 720), (1920, 1080), (390, 844)]


def api(path: str, data=None, method: str | None = None):
    req = urllib.request.Request(BASE + path, method=method or ("POST" if data is not None else "GET"))
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, body, timeout=60) as r:
        return json.loads(r.read().decode())


def wait_health(timeout=30):
    for _ in range(timeout * 2):
        try:
            api("/api/health")
            return True
        except Exception:
            time.sleep(0.5)
    return False


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    assert wait_health(), "server did not come up"

    # --- a fresh mock run for the RUNNING captures --------------------------
    src_id = None
    try:
        sources = api("/api/sources")["sources"]
        for s in sources:
            sid = s.get("source_id") or s.get("id")
            try:
                if api(f"/api/sources/{sid}/chunks")["count"] > 0:
                    src_id = sid
                    break
            except Exception:
                continue
    except Exception:
        pass
    print("live run source:", src_id)

    live_id = None
    try:
        run = api("/api/runs", {
            "source_id": src_id,
            "name": "QA capture — live (mock)",
            "config": {"agents": 8, "ticks": 8, "writes_per_tick": 4, "seed": 7},
            "scenario_json": {"question": "QA capture run", "events": []},
        })
        live_id = run["id"]
        api(f"/api/runs/{live_id}/start", {}, method="POST")
    except Exception as e:
        print("could not create live run:", e)

    # --- pick a completed run rich in real citations for the other tabs -----
    done_id = None
    best = -1
    candidates = [r for r in api("/api/runs")["runs"] if r["status"] in ("completed", "interrupted")]
    candidates.sort(key=lambda r: r["ticks_done"], reverse=True)
    for r in candidates[:4]:
        try:
            posts = api(f"/api/runs/{r['id']}/posts?limit=500")["posts"]
            cited = sum(1 for p in posts if p.get("cited_chunk_ids"))
            if cited > best:
                best = cited
                done_id = r["id"]
        except Exception:
            continue
    if done_id is None and candidates:
        done_id = candidates[0]["id"]
    if done_id is None:
        done_id = live_id
    print(f"completed run for tabs: {done_id} ({best} cited posts)")

    time.sleep(10)  # let the mock run produce a few ticks

    def shot(page, w, name, url, wait=900, full=False, tab=None, click=None, graph_wait=0):
        page.goto(url, wait_until="load", timeout=30000)
        page.wait_for_timeout(wait)
        if tab:
            page.click(f".tabs button:has-text('{tab}')")
            page.wait_for_timeout(wait)
        if graph_wait:
            page.wait_for_timeout(graph_wait)
        if click:
            try:
                page.wait_for_timeout(1200)  # let posts + chunk metadata settle
                page.click(click, timeout=8000)
                page.wait_for_timeout(900)
            except Exception as e:
                print(f"  click {click} failed: {e}")
        page.screenshot(path=str(OUT / f"final_{w}_{name}.png"), full_page=full)
        print(f"wrote final_{w}_{name}.png")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        for (w, h) in SIZES:
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
            page = ctx.new_page()
            page.on("console", lambda m: m.type == "error" and print("  console error:", m.text[:200]))
            print(f"--- viewport {w}x{h}")
            shot(page, w, "home", f"{BASE}/#/")
            shot(page, w, "wizard", f"{BASE}/#/new")
            if live_id:
                shot(page, w, "run_live", f"{BASE}/#/run/{live_id}")
            shot(page, w, "simulations", f"{BASE}/#/simulations")
            shot(page, w, "documents", f"{BASE}/#/documents")
            shot(page, w, "settings", f"{BASE}/#/settings")
            if done_id:
                shot(page, w, "run_agents", f"{BASE}/#/run/{done_id}", tab="Agents")
                shot(page, w, "run_network", f"{BASE}/#/run/{done_id}", tab="Network", graph_wait=2500)
                shot(page, w, "run_events", f"{BASE}/#/run/{done_id}", tab="Events")
                shot(page, w, "run_analysis", f"{BASE}/#/run/{done_id}", tab="Analysis", graph_wait=1500)
                shot(page, w, "run_log", f"{BASE}/#/run/{done_id}", tab="Log")
            if w == 1440 and done_id:
                shot(page, w, "run_evidence", f"{BASE}/#/run/{done_id}", tab="Live", click=".post .cite")
            if w == 390:
                shot(page, w, "run_live_full", f"{BASE}/#/run/{done_id}", full=True)
            ctx.close()
        browser.close()
    print("done")


if __name__ == "__main__":
    main()
