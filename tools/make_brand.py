"""Render The Social World identity assets with Playwright (geometry from the brand spec).

Reproducible: run from the repo root with the project venv:
    .venv/Scripts/python.exe tools/make_brand.py
"""
from __future__ import annotations

import struct
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "frontend" / "public" / "brand"
DOCS = ROOT / "docs" / "brand"
PUB.mkdir(parents=True, exist_ok=True)
DOCS.mkdir(parents=True, exist_ok=True)

MARK_INNER = """
<circle cx="24" cy="24" r="21" fill="none" stroke="#808994" stroke-width="1.6" stroke-dasharray="32 12" stroke-linecap="round" transform="rotate(-80 24 24)"/>
<circle cx="24" cy="12" r="2.4" fill="#E8EBEF"/>
<circle cx="34.39" cy="18" r="2.4" fill="#E8EBEF"/>
<circle cx="34.39" cy="30" r="2.4" fill="#E8EBEF"/>
<circle cx="24" cy="36" r="2.4" fill="#E8EBEF"/>
<circle cx="13.61" cy="30" r="2.4" fill="#E8EBEF"/>
<circle cx="13.61" cy="18" r="2.4" fill="#E8EBEF"/>
<rect x="19.5" y="19.5" width="9" height="9" rx="1.6" fill="#D6C6A1"/>
"""

MARK_LIGHT_INNER = MARK_INNER.replace("#808994", "#5F6874").replace("#E8EBEF", "#12151A").replace("#D6C6A1", "#7A5C1E")

FAVICON = (ROOT / "frontend" / "public" / "brand" / "favicon.svg").read_text(encoding="utf-8")


def svg_mark(inner: str, size: int) -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 48 48">{inner}</svg>')


def app_icon(size: int, circular: bool = False) -> str:
    mark = size * 0.65
    scale = mark / 48
    off = (size - mark) / 2
    radius = size / 2 if circular else round(size * 0.22, 2)
    if circular:
        bg = (f'<circle cx="{size/2}" cy="{size/2}" r="{size/2}" fill="#0F1216"/>'
              f'<circle cx="{size/2}" cy="{size/2}" r="{size/2 - .5}" fill="none" '
              f'stroke="#29303A" stroke-width="1"/>')
    else:
        bg = (f'<rect width="{size}" height="{size}" rx="{radius}" fill="#0F1216"/>'
              f'<rect x=".5" y=".5" width="{size-1}" height="{size-1}" rx="{max(0, radius-.5)}" '
              f'fill="none" stroke="#29303A" stroke-width="1"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {size} {size}">{bg}'
            f'<g transform="translate({off:.2f},{off:.2f}) scale({scale:.4f})">{MARK_INNER}</g></svg>')


def font_face(weight: int, family: str = "ibm-plex-sans") -> str:
    path = ROOT / "frontend" / "node_modules" / "@fontsource" / family / "files" / \
        f"{family}-latin-{weight}-normal.woff2"
    return (f'@font-face{{font-family:"Plex";src:url("{path.as_uri()}") format("woff2");'
            f'font-weight:{weight};font-style:normal;}}')


def render(browser, html: str, width: int, height: int, path: Path, transparent=False):
    page = browser.new_page(viewport={"width": width, "height": height}, device_scale_factor=1)
    page.set_content(html)
    page.screenshot(path=str(path), omit_background=transparent)
    page.close()


def write_ico(pngs: list[tuple[int, bytes]], path: Path) -> None:
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries = b""
    for size, data in pngs:
        w = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    path.write_bytes(header + entries + b"".join(d for _s, d in pngs))


def main() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # transparent marks for documents / README
        render(browser, svg_mark(MARK_INNER, 192), 192, 192, PUB / "mark-192.png", transparent=True)
        render(browser, svg_mark(MARK_LIGHT_INNER, 192), 192, 192, PUB / "mark-light-192.png", transparent=True)
        # favicons
        smalls = []
        for size in (16, 32, 48):
            svg = FAVICON.replace('width="16" height="16"', f'width="{size}" height="{size}"')
            html = f'<style>html,body{{margin:0;background:transparent}}</style>{svg}'
            path = PUB / f"favicon-{size}.png"
            render(browser, html, size, size, path, transparent=True)
            smalls.append((size, path.read_bytes()))
        write_ico(smalls, PUB / "favicon.ico")
        # app icons
        for size in (180, 192, 512):
            render(browser, app_icon(size), size, size, PUB / f"app-icon-{size}.png")
        # GitHub avatar (circular safe crop, mark at 60%)
        render(browser, app_icon(500, circular=True), 500, 500, DOCS / "github-avatar.png")
        # social preview
        faces = "".join(font_face(w) for w in (400, 500, 600))
        mono = font_face(400, "ibm-plex-mono").replace('font-family:"Plex"', 'font-family:"PlexMono"')
        html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
        {faces}{mono}
        html,body{{margin:0;width:1280px;height:640px;background:#090B0E;overflow:hidden}}
        .wrap{{position:relative;width:1280px;height:640px}}
        .mark{{position:absolute;left:112px;top:210px;width:200px;height:200px}}
        .text{{position:absolute;left:352px;top:236px;width:790px;font-family:Plex,sans-serif;color:#E8EBEF}}
        .word{{font-size:58px;line-height:1.1;letter-spacing:-.025em;white-space:nowrap}}
        .word .the{{font-weight:400;color:#A9B1BC}}
        .word .name{{font-weight:500}}
        .tag{{margin-top:26px;font-size:24px;line-height:1.4;color:#A9B1BC;font-weight:400;max-width:800px}}
        .meta{{margin-top:22px;font-family:PlexMono,monospace;font-size:15px;color:#808994;letter-spacing:.01em}}
        </style></head><body><div class="wrap">
        <div class="mark">{svg_mark(MARK_INNER, 200)}</div>
        <div class="text"><div class="word"><span class="the">The</span> <span class="name">Social World</span></div>
        <div class="tag">Simulate how a population argues about a document. Every argument links to its source.</div>
        <div class="meta">AI social simulation · open source · runs locally</div></div>
        </div></body></html>"""
        render(browser, html, 1280, 640, DOCS / "social-preview.png")
        browser.close()
    print("brand assets written")


if __name__ == "__main__":
    main()
