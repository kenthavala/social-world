"""Exports: json bundle + markdown summary. Never contains keys or base URLs."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from app import db
from app.errors import AppError

router = APIRouter(prefix="/api")


def _bundle(run_id: str) -> dict:
    r = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
    if r is None:
        raise AppError("run not found", component="api", stage="export", status_code=404)
    cfg = db.uj(r["config_json"], {}) or {}
    provider_meta = db.uj(r["provider_json"], {}) or {}
    src_id = r["source_id"]
    # the stored LLM essay, carried WITH its generated-not-counted label
    essay = None
    rep = db.query_one("SELECT essay_json, essay_meta_json FROM reports WHERE run_id=?", (run_id,))
    if rep is not None and rep["essay_json"]:
        sections = db.uj(rep["essay_json"], {})
        if sections:
            essay = {"honesty": "LLM draft; generated prose; not counted data",
                     "sections": sections, "meta": db.uj(rep["essay_meta_json"], {})}
    src_row = db.query_one("SELECT * FROM sources WHERE id=?", (src_id,)) if src_id else None
    report_row = db.query_one("SELECT * FROM reports WHERE run_id=?", (run_id,))
    return {
        "run": {"id": r["id"], "name": r["name"], "status": r["status"], "seed": r["seed"],
                "source_id": r["source_id"],
                "scenario": db.uj(r["scenario_json"], {}), "config": cfg,
                "provider_json": provider_meta,
                "created_at": r["created_at"],
                "started_at": r["started_at"], "finished_at": r["finished_at"],
                "current_tick": r["current_tick"], "last_completed_tick": r["last_completed_tick"],
                "ticks_done": r["last_completed_tick"], "llm_calls_used": r["llm_calls_used"],
                "error": db.uj(r["error_json"]),
                "parent_run_id": r["parent_run_id"], "branch_round": r["branch_round"],
                "manifest": db.uj(r["manifest_json"], {}),
                "provider_hint": {"provider": provider_meta.get("name"),
                                  "model": provider_meta.get("model")}},
        "source": db.uj(db.scalar("SELECT brief_json FROM sources WHERE id=?",
                                  (src_id,)) or "{}", {}) if src_id else None,
        "source_record": ({"id": src_row["id"], "filename": src_row["filename"],
                           "sha256": src_row["sha256"], "kind": src_row["kind"],
                           "pages": src_row["pages"], "created_at": src_row["created_at"],
                           "status": src_row["status"]} if src_row else None),
        "chunks": [_chunk(c) for c in db.query(
            "SELECT id, idx, n_words, heading, page_start, page_end, text FROM chunks"
            " WHERE source_id=? ORDER BY idx", (src_id,))] if src_id else [],
        "agents": [_agent(a) for a in db.query("SELECT * FROM agents WHERE run_id=?", (run_id,))],
        "posts": [_post(p) for p in db.query(
            "SELECT * FROM posts WHERE run_id=? ORDER BY seq, tick", (run_id,))],
        "edges": [dict(e) for e in db.query("SELECT * FROM edges WHERE run_id=?", (run_id,))],
        "memories": [{"tick": m["tick"], "agent_id": m["agent_id"], "kind": m["kind"],
                      "text": m["text"], "importance": m["importance"],
                      "refs": db.uj(m["refs_json"], [])}
                     for m in db.query("SELECT * FROM memories WHERE run_id=? ORDER BY tick, id",
                                       (run_id,))],
        "metrics": [db.uj(m["metrics_json"], {}) for m in
                    db.query("SELECT * FROM metrics WHERE run_id=? ORDER BY tick", (run_id,))],
        "stance_history": [dict(s) for s in db.query(
            "SELECT tick, issue_id, ROUND(AVG(value), 4) AS mean FROM stance_history"
            " WHERE run_id=? GROUP BY tick, issue_id ORDER BY tick, issue_id", (run_id,))],
        "stance_history_rows": [{"tick": s["tick"], "agent_id": s["agent_id"],
                                 "issue_id": s["issue_id"], "value": s["value"],
                                 "confidence": s["confidence"]}
                                for s in db.query(
                                    "SELECT tick, agent_id, issue_id, value, confidence"
                                    " FROM stance_history WHERE run_id=? ORDER BY tick, id",
                                    (run_id,))],
        "events": [{"tick": e["tick"], "kind": e["kind"], "payload": db.uj(e["payload_json"], {}),
                    "created_at": e["created_at"]}
                   for e in db.query("SELECT * FROM events WHERE run_id=? ORDER BY id", (run_id,))],
        "llm_calls": [{"id": c["id"], "task": c["task"], "provider": c["provider"],
                       "model": c["model"], "status": c["status"],
                       "parsed_ok": c["parsed_ok"], "error": c["error"],
                       "tokens_in": c["tokens_in"], "tokens_out": c["tokens_out"],
                       "latency_ms": c["latency_ms"], "created_at": c["created_at"]}
                      for c in db.query("SELECT * FROM llm_calls WHERE run_id=? ORDER BY id",
                                        (run_id,))],
        "llm_stats": {"calls": db.scalar("SELECT COUNT(*) FROM llm_calls WHERE run_id=?",
                                         (run_id,)) or 0},
        "report": {"origin": "Counted report + optional labelled generated essay",
                   "essay": essay,
                   "counted": ({"report_md": report_row["report_md"],
                                "analytics": db.uj(report_row["analytics_json"], {}),
                                "report_json": db.uj(report_row["report_json"], {}),
                                "created_at": report_row["created_at"]}
                               if report_row else None)},
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }


def _agent(a) -> dict:
    return {"id": a["id"], "handle": a["handle"], "name": a["name"], "bio": a["bio"],
            "archetype": a["archetype"], "group": a["stakeholder_group"],
            "persona": db.uj(a["persona_json"], {}), "big5": db.uj(a["personality_json"], {}),
            "traits": db.uj(a["traits_json"], {}), "goals": db.uj(a["goals_json"], []),
            "interests": db.uj(a["interests_json"], []),
            "stances": db.uj(a["stances_json"], {}), "state": db.uj(a["state_json"], {}),
            "knowledge": db.uj(a["knowledge_json"], []),
            "belief_summary": a["belief_summary"]}


def _post(p) -> dict:
    return {"id": p["id"], "tick": p["tick"], "agent_id": p["agent_id"], "kind": p["kind"],
            "parent_id": p["parent_id"], "text": p["text"],
            "stance": db.uj(p["stance_json"], {}), "emotion": p["emotion"],
            "cited_chunk_ids": db.uj(p["cited_chunk_ids_json"], []),
            "likes": p["likes"], "reposts": p["reposts"], "replies": p["replies"],
            "is_fallback": p["is_fallback"], "seq": p["seq"], "model": p["model"],
            "provider": p["provider"], "via_fallback": p["via_fallback"]}


def _chunk(c) -> dict:
    return {"id": c["id"], "idx": c["idx"], "n_words": c["n_words"],
            "heading": c["heading"], "page_start": c["page_start"],
            "page_end": c["page_end"], "text": c["text"]}


def _safe_pdf_text(text: object) -> str:
    s = str(text if text is not None else "")
    for a, b in (("—", "-"), ("–", "-"), ("→", "->"), ("←", "<-"), ("·", "-"),
                 ("•", "-"), ("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'),
                 ("…", "...")):
        s = s.replace(a, b)
    return s.encode("latin-1", "replace").decode("latin-1")


def _pdf_bytes(data: dict) -> bytes:
    """A print-friendly report: counted sections first, the labelled generated
    summary second, and the manifest/source references on every export."""
    import math
    import textwrap

    import pymupdf as fitz

    run = data["run"]
    cfg = run.get("config") or {}
    provider = run.get("provider_json") or run.get("provider_hint") or {}
    sample = data.get("sample") or {}
    mock = (provider.get("name") == "mock") or bool(sample.get("mock"))
    posts = data.get("posts") or []
    agents = data.get("agents") or []
    chunks = data.get("chunks") or []
    chunk_by_id = {c["id"]: c for c in chunks}
    report = data.get("report") or {}
    counted = report.get("counted") or {}
    analytics = counted.get("analytics") or {}
    report_json = counted.get("report_json") or {}
    essay = report.get("essay")
    manifest = run.get("manifest") or data.get("manifest") or {}
    run_id = run.get("id") or ""
    W, H, M = 595, 842, 56
    BOT = H - 52
    TEXT = (0.07, 0.08, 0.11)
    SEC = (0.34, 0.36, 0.41)
    LINE = (0.83, 0.84, 0.86)
    PAPER = (0.985, 0.975, 0.95)
    RING = (0.38, 0.40, 0.44)
    SOURCE = (0.48, 0.36, 0.12)
    doc = fitz.open()
    state: dict = {"page": None, "y": 0}

    def new_page(title: str = "") -> None:
        page = doc.new_page(width=W, height=H)
        if title:
            page.insert_text((M, 32), _safe_pdf_text(title), fontsize=8,
                             fontname="hebo", color=SEC)
            page.draw_line((M, 40), (W - M, 40), color=LINE, width=0.6)
        state["page"] = page
        state["y"] = 58

    def need(height: float) -> None:
        if state["page"] is None or state["y"] + height > BOT:
            new_page("The Social World - simulation report")

    def line(text: str, size: float = 10.5, font: str = "helv",
             color=TEXT, leading: float = 14.5, gap: float = 4) -> None:
        need(leading)
        state["page"].insert_text((M, state["y"]), _safe_pdf_text(text),
                                  fontsize=size, fontname=font, color=color)
        state["y"] += leading + gap

    def para(text: str, size: float = 10.5, color=TEXT, font: str = "helv",
             leading: float = 14.5, gap: float = 8) -> None:
        width = max(24, int((W - 2 * M) / (size * 0.505)))
        for block in str(text).split("\n"):
            if not block.strip():
                state["y"] += 5
                continue
            for ln in textwrap.wrap(_safe_pdf_text(block), width=width,
                                    break_long_words=False, break_on_hyphens=False):
                need(leading)
                state["page"].insert_text((M, state["y"]), ln, fontsize=size,
                                          fontname=font, color=color)
                state["y"] += leading
            state["y"] += gap

    def heading(text: str, size: float = 15) -> None:
        need(size + 22)
        state["y"] += 4
        state["page"].insert_text((M, state["y"]), _safe_pdf_text(text),
                                  fontsize=size, fontname="hebo", color=TEXT)
        state["y"] += size + 10

    def table(headers: list[str], rows: list[dict], widths: list[float],
              size: float = 8.5) -> None:
        def header() -> None:
            nonlocal state
            need(18)
            x = M
            for h, w in zip(headers, widths):
                state["page"].insert_text((x, state["y"]), _safe_pdf_text(h),
                                          fontsize=size, fontname="hebo", color=SEC)
                x += w
            state["y"] += 12
            state["page"].draw_line((M, state["y"] - 6), (W - M, state["y"] - 6),
                                    color=LINE, width=0.5)
            state["y"] += 4

        header()
        for r in rows:
            cells = []
            for h, w in zip(headers, widths):
                max_chars = max(6, int(w / (size * 0.52)))
                cells.append(textwrap.wrap(_safe_pdf_text(r.get(h, "")),
                                           width=max_chars, break_long_words=True) or [""])
            height = max(len(c) for c in cells) * (size + 2.6) + 4
            if state["y"] + height > BOT:
                new_page("The Social World - simulation report")
                header()
            x = M
            for c, w in zip(cells, widths):
                yy = state["y"]
                for ln in c:
                    state["page"].insert_text((x, yy), ln, fontsize=size,
                                              fontname="helv", color=TEXT)
                    yy += size + 2.6
                x += w
            state["y"] += height
        state["y"] += 6

    # ---------------- cover ----------------
    page = doc.new_page(width=W, height=H)
    state["page"], state["y"] = page, 62
    cx, cy, r = 86, 82, 28
    page.draw_circle((cx, cy), r, color=RING, width=1.6)
    for i in range(6):
        ang = math.radians(-90 + i * 60)
        page.draw_circle((cx + math.cos(ang) * r * 0.66, cy + math.sin(ang) * r * 0.66),
                         2.2, color=RING, fill=RING)
    page.draw_rect(fitz.Rect(cx - 6, cy - 6, cx + 6, cy + 6), color=SOURCE,
                   fill=SOURCE, width=0.5)
    page.insert_text((128, 72), "The Social World", fontsize=11,
                     fontname="hebo", color=TEXT)
    page.insert_text((128, 90), "Simulation report", fontsize=19,
                     fontname="hebo", color=TEXT)
    page.insert_text((128, 106), "An AI social simulation lab", fontsize=9,
                     fontname="helv", color=SEC)
    state["y"] = 150
    line(run.get("name") or "Untitled run", size=21, font="hebo", leading=26)
    state["y"] += 6
    box = fitz.Rect(M, state["y"], W - M, state["y"] + 58)
    page.draw_rect(box, color=LINE, fill=(0.985, 0.98, 0.965), width=0.8)
    page.insert_text((M + 10, state["y"] + 18), "SIMULATED DATA", fontsize=9,
                     fontname="hebo", color=SOURCE)
    page.insert_textbox(fitz.Rect(M + 10, state["y"] + 24, W - M - 10, state["y"] + 54),
                        "Agents are AI-generated. This is a simulation, not a forecast of "
                        "real opinion. Counted sections are computed from stored rows; the "
                        "generated summary is labelled separately.",
                        fontsize=8.5, fontname="helv", color=SEC, lineheight=1.35)
    state["y"] += 72
    if mock:
        mbox = fitz.Rect(M, state["y"], W - M, state["y"] + 30)
        page.draw_rect(mbox, color=(0.55, 0.38, 0.08), fill=(0.99, 0.95, 0.84), width=0.9)
        page.insert_text((M + 10, state["y"] + 19),
                         "MOCK PROVIDER - NOT MODEL OUTPUT. Every post here is synthetic template text.",
                         fontsize=8.5, fontname="hebo", color=(0.45, 0.30, 0.05))
        state["y"] += 42
    manifest_rows = [
        ("Run ID", run_id),
        ("Status", run.get("status") or "not recorded"),
        ("Provider / model", f"{provider.get('name') or 'not recorded'} / "
                             f"{provider.get('model') or 'not recorded'}"),
        ("Seed", str(run.get("seed") if run.get("seed") is not None else "not recorded")),
        ("World", f"{cfg.get('agents', analytics.get('agents', 'not recorded'))} agents · "
                  f"{cfg.get('ticks', 'not recorded')} rounds · "
                  f"{cfg.get('writes_per_tick', 'not recorded')} writes/round"),
        ("Source", (data.get("source_record") or {}).get("filename") or "not recorded"),
        ("Source SHA-256", (manifest.get("source_sha256") or
                            (data.get("source_record") or {}).get("sha256") or "not recorded")),
        ("App / prompt", f"{manifest.get('app_version') or 'not recorded'} / "
                         f"{manifest.get('prompt_version') or 'not recorded'}"),
        ("Window (UTC)", f"{str(run.get('started_at') or '-')[:19]} to "
                         f"{str(run.get('finished_at') or '-')[:19]}"),
    ]
    for k, v in manifest_rows:
        need(15)
        state["page"].insert_text((M, state["y"]), k, fontsize=8.5,
                                  fontname="hebo", color=SEC)
        state["page"].insert_textbox(
            fitz.Rect(M + 116, state["y"] - 8, W - M, state["y"] + 8),
            _safe_pdf_text(v), fontsize=8.5, fontname="helv", color=TEXT)
        state["y"] += 15

    # ---------------- counted summary ----------------
    new_page("The Social World - simulation report · counted data")
    heading("Counted summary", 17)
    posts_with_source = sum(1 for p in posts if p.get("cited_chunk_ids"))
    citations = sum(len(p.get("cited_chunk_ids") or []) for p in posts)
    distinct_chunks = len({c for p in posts for c in (p.get("cited_chunk_ids") or [])})
    para(
        f"{len(posts)} posts recorded; {posts_with_source} of {len(posts)} cite at least "
        f"one source chunk. {citations} citation references span {distinct_chunks} distinct "
        f"chunks. {len(agents)} agents, {len(data.get('edges') or [])} recorded relationships.",
        gap=4)
    if report_json.get("turning_points"):
        tp = report_json["turning_points"][0]
        para(f"Largest recorded round-to-round stance shift: {tp.get('issue_id')} at round "
             f"{tp.get('tick')}, {tp.get('from'):+.2f} to {tp.get('to'):+.2f}.", gap=4)
    if report_json.get("source_usage"):
        u = report_json["source_usage"][0]
        para(f"Most-cited passage: page {u.get('page_start')} "
             f"({u.get('chunk_id')}), cited {u.get('citations')} times.", gap=8)

    heading("Posts by round", 13)
    by_round: dict[int, dict] = {}
    for p in posts:
        vals = [float(v.get("value", 0)) for v in (p.get("stance") or {}).values()
                if isinstance(v, dict)]
        mean = sum(vals) / max(1, len(vals)) if vals else 0
        b = "pro" if mean > 0.15 else "con" if mean < -0.15 else "neu"
        row = by_round.setdefault(p.get("tick") or 0,
                                  {"Round": p.get("tick") or 0, "Posts": 0, "Supports": 0,
                                   "Undecided": 0, "Opposes": 0, "Sourced": 0})
        row["Posts"] += 1
        row[{"pro": "Supports", "con": "Opposes", "neu": "Undecided"}[b]] += 1
        if p.get("cited_chunk_ids"):
            row["Sourced"] += 1
    table(["Round", "Posts", "Supports", "Undecided", "Opposes", "Sourced"],
          [by_round[k] for k in sorted(by_round)], [52, 52, 82, 92, 82, 70])

    heading("Most-cited source passages", 13)
    cite_count: dict[str, int] = {}
    for p in posts:
        for cid in p.get("cited_chunk_ids") or []:
            cite_count[cid] = cite_count.get(cid, 0) + 1
    cite_rows = []
    for cid, n in sorted(cite_count.items(), key=lambda kv: (-kv[1], kv[0]))[:10]:
        c = chunk_by_id.get(cid) or {}
        cite_rows.append({
            "Page": f"{c.get('page_start') or '?'}" +
                    (f"-{c.get('page_end')}" if c.get("page_end") not in (None, c.get("page_start")) else ""),
            "Chunk": cid,
            "Heading": (c.get("heading") or "(no heading)")[:52],
            "Citations": n,
            "Share": f"{n} of {posts_with_source}" if posts_with_source else "0 of 0",
        })
    table(["Page", "Chunk", "Heading", "Citations", "Share"], cite_rows,
          [44, 112, 238, 62, 76])
    if not cite_rows:
        para("No post cites a source chunk in this run.", color=SEC)

    heading("Agents", 13)
    agent_counts: dict[str, int] = {}
    for p in posts:
        agent_counts[p.get("agent_id")] = agent_counts.get(p.get("agent_id"), 0) + 1
    agent_rows = sorted(
        ({"Agent": f"@{a.get('handle') or a.get('id')}", "Name": a.get("name") or "",
          "Group": a.get("group") or "unassigned", "Posts": agent_counts.get(a.get("id"), 0)}
         for a in agents),
        key=lambda r: (-r["Posts"], r["Agent"]))[:12]
    table(["Agent", "Name", "Group", "Posts"], agent_rows, [100, 136, 190, 58])

    authored = []
    for e in data.get("events") or []:
        payload = e.get("payload") or {}
        if e.get("kind") in ("scheduled", "news") or payload.get("text"):
            authored.append({
                "Round": e.get("tick", ""),
                "Kind": e.get("kind", ""),
                "Audience": payload.get("audience") or "everyone",
                "Text": (payload.get("text") or "")[:140],
            })
    if authored:
        heading("Interventions", 13)
        table(["Round", "Kind", "Audience", "Text"], authored[-12:], [44, 72, 100, 268])

    # ---------------- generated summary ----------------
    if essay and essay.get("sections"):
        new_page("The Social World - simulation report · generated section")
        heading("Executive summary", 17)
        meta = essay.get("meta") or {}
        box_y = state["y"]
        para("GENERATED - NOT COUNTED DATA. This prose was written by a model from the "
             "counted snapshot; it can paraphrase and must not be read as measured data.",
             size=8.8, color=SEC, gap=2)
        state["page"].draw_rect(fitz.Rect(M - 4, box_y - 12, W - M + 4, state["y"] + 2),
                                color=(0.55, 0.55, 0.58), width=0.7, dashes="[3 2] 0")
        para(f"Provider {meta.get('provider') or 'not recorded'} / "
             f"{meta.get('model') or 'not recorded'} · written "
             f"{str(meta.get('created_at') or '')[:19]} UTC · "
             f"{'cache hit' if meta.get('from_cache') else 'one recorded call'}",
             size=8.5, color=SEC, gap=6)
        labels = {
            "executive_summary": "Headline", "opinion_shifts": "Where opinion moved",
            "emerging_narratives": "Narrative threads", "influential_agents": "Influential voices",
            "communities": "Communities", "key_events": "Events",
            "contradictions": "Contradictions", "unexpected_outcomes": "Unexpected",
            "limitations": "Limits",
        }
        for key, label in labels.items():
            v = str((essay.get("sections") or {}).get(key) or "").strip()
            if v:
                state["y"] += 2
                line(label, size=9, font="hebo", color=SEC, leading=12, gap=1)
                para(v, size=9.6, leading=13.2, gap=6)

    # ---------------- source references ----------------
    new_page("The Social World - simulation report · source references")
    heading("Source references", 17)
    para("The chunk IDs and page bounds recorded with the source. A citation records which "
         "chunk an agent referenced; it does not prove the post represents it fairly.",
         size=8.8, color=SEC, gap=6)
    for c in chunks[:60]:
        need(34)
        pages_txt = f"p. {c.get('page_start')}" + (
            f"-{c.get('page_end')}" if c.get("page_end") not in (None, c.get("page_start")) else "")
        line(f"{pages_txt} · {c.get('id')} · {(c.get('heading') or '')[:70]}",
             size=8.5, font="hebo", color=SOURCE, leading=11, gap=0)
        para((c.get("text") or "")[:220].replace("\n", " "), size=8.2,
             color=SEC, leading=10.8, gap=6)
    if len(chunks) > 60:
        para(f"{len(chunks) - 60} further chunks are in the JSON/CSV export.", color=SEC)

    # ---------------- manifest footer ----------------
    new_page("The Social World - simulation report · manifest")
    heading("Run manifest", 17)
    for k, v in manifest_rows:
        line(f"{k}: {v}", size=9, leading=13, gap=2)
    line("Prompt version: " + str(manifest.get("prompt_version") or "not recorded"),
         size=9, leading=13, gap=2)
    line("Exported: " + str(data.get("exported_at") or ""), size=9, leading=13, gap=2)
    line("The full raw bundle (JSON/CSV) is available from the run's Find/Export controls.",
         size=8.5, color=SEC, leading=12, gap=2)

    # ---------------- footers / watermark ----------------
    n = doc.page_count
    for i in range(n):
        p = doc[i]
        p.insert_text((M, H - 28),
                      _safe_pdf_text(f"The Social World · {run_id} · simulated data"),
                      fontsize=7.2, fontname="helv", color=SEC)
        p.insert_text((W - M - 62, H - 28), f"page {i + 1} of {n}",
                      fontsize=7.2, fontname="helv", color=SEC)
        if mock:
            p.insert_text((120, 430), "MOCK PROVIDER", fontsize=17,
                          fontname="hebo", color=(0.86, 0.82, 0.74))
            p.insert_text((120, 450), "NOT MODEL OUTPUT", fontsize=17,
                          fontname="hebo", color=(0.86, 0.82, 0.74))
    return doc.tobytes(garbage=4, deflate=True)


@router.get("/runs/{run_id}/export")
def export_run(run_id: str, format: str = "json") -> Response:
    data = _bundle(run_id)
    fmt = (format or "json").lower()
    if fmt == "pdf":
        return Response(_pdf_bytes(data), media_type="application/pdf",
                        headers={"Content-Disposition":
                                 f'attachment; filename="the-social-world_{run_id}.pdf"'})
    if fmt == "json":
        return JSONResponse(data, media_type="application/json",
                            headers={"Content-Disposition":
                                     f'attachment; filename="{run_id}.json"'})
    if fmt == "md":
        md = _bundle_md(data)
        return Response(md, media_type="text/markdown",
                        headers={"Content-Disposition":
                                 f'attachment; filename="{run_id}.md"'})
    if fmt == "csv":
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("agents.csv", _csv(data["agents"],
                       ["id", "handle", "name", "archetype", "group"]))
            z.writestr("posts.csv", _csv(data["posts"],
                       ["id", "tick", "agent_id", "kind", "parent_id", "text", "likes",
                        "reposts", "replies", "is_fallback"]))
            z.writestr("edges.csv", _csv(data["edges"], ["src", "dst", "follows", "weight"]))
            z.writestr("stance_history.csv", _csv(data["stance_history"],
                       ["tick", "issue_id", "mean"]))
            z.writestr("llm_calls.csv", _csv(data["llm_calls"],
                       ["id", "task", "provider", "model", "status", "parsed_ok",
                        "tokens_in", "tokens_out", "latency_ms", "created_at"]))
            z.writestr("chunks.csv", _csv(data["chunks"],
                       ["id", "heading", "page_start", "page_end"]))
            z.writestr("metrics.json", json.dumps(data["metrics"], indent=2))
            z.writestr("run.json", json.dumps(data["run"], indent=2))
        return Response(buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition":
                                 f'attachment; filename="{run_id}_csv.zip"'})
    raise AppError("format must be json, md, csv or pdf", component="api", stage="export")


def _csv(rows: list[dict], cols: list[str]) -> str:
    import csv as _csv
    out = io.StringIO()
    w = _csv.DictWriter(out, fieldnames=cols, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        flat = {}
        for c in cols:
            v = r.get(c)
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            flat[c] = v
        w.writerow(flat)
    return out.getvalue()


def _bundle_md(data: dict) -> str:
    run = data["run"]
    cfg = run["config"]
    provider = run.get("provider_json") or run.get("provider_hint") or {}
    sample = data.get("sample") or {}
    mock = (provider.get("name") == "mock") or bool(sample.get("mock"))
    manifest = run.get("manifest") or data.get("manifest") or {}
    source_rec = data.get("source_record") or {}
    calls = data.get("llm_calls") or []
    by_status: dict[str, int] = {}
    for c in calls:
        by_status[c.get("status") or "?"] = by_status.get(c.get("status") or "?", 0) + 1
    call_line = " · ".join(f"{k} {v}" for k, v in sorted(by_status.items())) or "0 calls"
    lines = [
        f"# The Social World run: {run['name']}",
        "",
        "> **Simulated data.** Agents are AI-generated. This is a simulation, not a forecast "
        "of real opinion. Counted sections are computed from stored rows; the generated "
        "summary is labelled separately.",
        "",
        f"- **Run ID**: `{run['id']}` · **status**: {run['status']} · "
        f"**rounds done**: {run.get('ticks_done')} · **LLM calls**: {run.get('llm_calls_used')}",
        f"- **Window**: {run.get('started_at') or '—'} → {run.get('finished_at') or '—'} (UTC)",
        f"- **Provider / model**: {provider.get('name') or 'not recorded'} / "
        f"{provider.get('model') or 'not recorded'}",
        f"- **Seed**: `{run['seed']}` · **agents**: {cfg.get('agents')} · "
        f"**rounds**: {cfg.get('ticks')} · **writes/round**: {cfg.get('writes_per_tick')}",
        f"- **Source**: {source_rec.get('filename') or 'not recorded'} · "
        f"SHA-256 `{manifest.get('source_sha256') or source_rec.get('sha256') or 'not recorded'}`",
        f"- **App / prompt**: {manifest.get('app_version') or 'not recorded'} / "
        f"{manifest.get('prompt_version') or 'not recorded'}",
        f"- **Exported**: {data['exported_at']}",
        "",
    ]
    if mock:
        lines += ["> **MOCK PROVIDER — NOT MODEL OUTPUT.** Every post in this run is "
                  "synthetic template text produced by the offline mock.", ""]
    lines += [
        "## Scenario",
        "",
        "```",
        str(run.get("scenario", {}).get("question") or "")[:800],
        "```",
        "",
        "## LLM calls by outcome",
        "",
        call_line,
        "",
        "## Counted metrics by round",
        "",
        "| round | posts | mean stances |",
        "| --- | --- | --- |",
    ]
    for m in data["metrics"]:
        means = ", ".join(f"{iid}={vals['mean']:.2f}" for iid, vals in
                          (m.get("by_issue") or {}).items())
        lines.append(f"| {m.get('tick')} | {m.get('posts')} | {means} |")
    cite_count: dict[str, int] = {}
    for p in data["posts"]:
        for cid in p.get("cited_chunk_ids") or []:
            cite_count[cid] = cite_count.get(cid, 0) + 1
    lines += ["", "## Source references", "",
              "| page | chunk | heading | citations |", "| --- | --- | --- | --- |"]
    for c in data["chunks"]:
        pages = f"{c.get('page_start') or '?'}" + (
            f"-{c.get('page_end')}" if c.get("page_end") not in (None, c.get("page_start")) else "")
        lines.append(f"| {pages} | `{c['id']}` | {(c.get('heading') or '')[:70]} | "
                     f"{cite_count.get(c['id'], 0)} |")
    lines += ["", "## Posts", ""]
    for p in data["posts"][:500]:
        author = next((a["handle"] for a in data["agents"] if a["id"] == p["agent_id"]),
                      p["agent_id"])
        lines.append(f"**round {p['tick']} — @{author} [{p['kind']}]:** {p['text']}")
        if p.get("cited_chunk_ids"):
            lines.append(f"  (source: {', '.join('%s' % c for c in p['cited_chunk_ids'])})")
    if len(data["posts"]) > 500:
        lines.append(f"_{len(data['posts']) - 500} further posts are in the JSON/CSV export._")
    essay = (data.get("report") or {}).get("essay")
    if essay:
        from app.analytics.report import essay_markdown
        lines += ["", essay_markdown(essay["meta"], essay["sections"]), ""]
    lines += ["", "---", "",
              f"_The Social World · run `{run['id']}` · simulated data · "
              f"generated summary labelled separately._"]
    return "\n".join(lines)
