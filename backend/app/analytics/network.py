"""Network analytics (PageRank / Louvain) over the static follow graph in SQLite."""
from __future__ import annotations

from typing import Any

import networkx as nx

from app import db


def graph_for_run(run_id: str, tick: int | None = None) -> nx.DiGraph:
    g = nx.DiGraph()
    agents = db.query("SELECT id, handle, name, archetype, stakeholder_group, stances_json,"
                      " traits_json FROM agents WHERE run_id=?", (run_id,))
    for a in agents:
        g.add_node(a["id"], handle=a["handle"], name=a["name"], archetype=a["archetype"],
                   group=a["stakeholder_group"], stances=db.uj(a["stances_json"], {}),
                   traits=db.uj(a["traits_json"], {}))
    if tick is None:
        rows = db.query("SELECT src, dst, follows, weight FROM edges WHERE run_id=?", (run_id,))
    else:
        rows = db.query(
            "SELECT src, dst, follows, weight FROM edge_history WHERE run_id=? AND tick=?",
            (run_id, tick))
        if not rows:
            rows = db.query("SELECT src, dst, follows, weight FROM edges WHERE run_id=?", (run_id,))
    for r in rows:
        if g.has_node(r["src"]) and g.has_node(r["dst"]):
            g.add_edge(r["src"], r["dst"], follows=r["follows"], weight=r["weight"])
    return g


def _pagerank(g: nx.DiGraph, weight: str, damping: float = 0.85,
              iters: int = 50, tol: float = 1e-8) -> dict[str, float]:
    """Pure-Python PageRank (no scipy dependency). Deterministic ordering by node list."""
    nodes = list(g.nodes())
    n = len(nodes)
    if n == 0:
        return {}
    out_w = {u: sum(g[u][v].get(weight, 1.0) or 1.0 for v in g.successors(u))
             for u in nodes}
    rank = {node: 1.0 / n for node in nodes}
    for _ in range(iters):
        base = (1.0 - damping) / n
        new = {node: base for node in nodes}
        for u in nodes:
            w_out = out_w[u]
            if w_out <= 0.0:  # dangling: spread evenly
                share = damping * rank[u] / n
                for v in nodes:
                    new[v] += share
                continue
            for v in g.successors(u):
                new[v] += damping * rank[u] * (g[u][v].get(weight, 1.0) or 1.0) / w_out
        err = sum(abs(new[node] - rank[node]) for node in nodes)
        rank = new
        if err < tol:
            break
    total = sum(rank.values()) or 1.0
    return {node: rank[node] / total for node in nodes}


def influencers(g: nx.DiGraph, top: int = 10) -> list[dict]:
    if g.number_of_nodes() == 0:
        return []
    pr = _pagerank(g, weight="weight")
    ranked = sorted(pr.items(), key=lambda kv: (-kv[1], kv[0]))[:top]
    out = []
    for node, score in ranked:
        data = g.nodes[node]
        out.append({"agent_id": node, "handle": data.get("handle"),
                    "name": data.get("name"), "pagerank": round(score, 5),
                    "followers": g.in_degree(node)})
    return out


def communities(g: nx.DiGraph) -> list[dict]:
    if g.number_of_nodes() == 0:
        return []
    undirected = g.to_undirected()
    try:
        comms = nx.community.louvain_communities(undirected, seed=7)
    except Exception:  # older networkx
        comms = list(nx.community.modularity_max.greedy_modularity_communities(undirected))
    return [{"nodes": sorted(c), "size": len(c)} for c in comms if len(c) > 0]


def density(g: nx.DiGraph) -> float:
    n = g.number_of_nodes()
    return round(nx.density(g), 4) if n else 0.0


def modularity(g: nx.DiGraph) -> float:
    if g.number_of_nodes() == 0:
        return 0.0
    try:
        comms = nx.community.louvain_communities(g.to_undirected(), seed=7)
        return round(nx.community.modularity(g.to_undirected(), comms, weight="weight"), 4)
    except Exception:
        return 0.0


def summary(run_id: str, tick: int | None = None) -> dict[str, Any]:
    g = graph_for_run(run_id, tick)
    return {
        "nodes": g.number_of_nodes(),
        "edges": g.number_of_edges(),
        "density": density(g),
        "modularity": modularity(g),
        "influencers": influencers(g),
        "communities": communities(g),
    }
