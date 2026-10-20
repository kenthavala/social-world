"""Directed relationship edges: weights, follow flags, decay + trust."""
from __future__ import annotations


def ensure(edges: dict[str, dict], src: str, dst: str, follows: int = 0,
           weight: float = 0.0) -> dict:
    key = f"{src}|{dst}"
    if key not in edges:
        edges[key] = {"src": src, "dst": dst, "follows": follows,
                      "weight": weight, "interactions": 0}
    return edges[key]


def bump(edges: dict[str, dict], src: str, dst: str, delta: float,
         interaction: bool = True) -> None:
    edge = ensure(edges, src, dst)
    edge["weight"] = max(-1.0, min(1.0, edge["weight"] + delta))
    if interaction:
        edge["interactions"] += 1


def reaction(edges: dict[str, dict], src: str, dst: str) -> None:
    bump(edges, src, dst, +0.08)


def reply(edges: dict[str, dict], src: str, dst: str, agree: bool) -> None:
    bump(edges, src, dst, +0.05 if agree else -0.08)


def decay(edges: dict[str, dict], factor: float = 0.97) -> None:
    for edge in edges.values():
        edge["weight"] = round(edge["weight"] * factor, 4)
        if not edge["follows"] and abs(edge["weight"]) < 0.02 and edge["interactions"] == 0:
            continue  # keep sparse seed edges


def trust_in(edges: dict[str, dict], src: str, dst: str | None) -> float:
    if not dst:
        return 0.5  # unknown author (e.g. newsroom) is neutral
    edge = edges.get(f"{src}|{dst}")
    return 0.5 + 0.5 * max(0.0, edge["weight"]) if edge else 0.5


def set_follow(edges: dict[str, dict], src: str, dst: str, follows: bool) -> bool:
    edge = ensure(edges, src, dst)
    changed = bool(edge["follows"]) != follows
    edge["follows"] = 1 if follows else 0
    edge["interactions"] = edge.get("interactions", 0)
    return changed
