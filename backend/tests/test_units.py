"""Memory, opinion, and relation unit tests for the deterministic formulas."""
from __future__ import annotations

from app.sim import memory, opinion, relations


def _agent(stances=None, traits=None):
    return {
        "id": "agent_a",
        "stances": stances or {"iss_1": {"value": 0.0, "confidence": 0.5}},
        "traits": traits or {"tolerance": 0.6, "stubbornness": 0.3},
        "memories": [],
    }


def _post(author="agent_b", value=0.8):
    return {"id": "p_1", "agent_id": author,
            "stance": {"iss_1": {"value": value, "confidence": 0.5}}}


def test_bounded_confidence_moves_toward_post():
    a = _agent()
    author = {"id": "agent_b"}
    opinion.update_from_post(a, author, _post(), ["iss_1"], liked=False, replied=False,
                             backfire_enabled=True, edge_weight=0.5)
    new = a["stances"]["iss_1"]["value"]
    assert 0.0 < new < 0.8  # partially moved toward +0.8
    assert a["stances"]["iss_1"]["confidence"] == pytest.approx(0.53)


import pytest  # noqa: E402


def test_author_shift_30pct():
    a = _agent()
    opinion.apply_author_shift(a, {"stance": {"iss_1": {"value": 0.8}}}, ["iss_1"])
    assert a["stances"]["iss_1"]["value"] == pytest.approx(0.24)


def test_backfire_when_far_and_hostile():
    a = _agent(stances={"iss_1": {"value": -0.5, "confidence": 0.5}},
               traits={"tolerance": 0.2, "stubbornness": 0.3})
    author = {"id": "agent_b"}
    before = a["stances"]["iss_1"]["value"]
    opinion.update_from_post(a, author, _post(value=0.9), ["iss_1"], False, False, True, -0.5)
    after = a["stances"]["iss_1"]["value"]
    assert after < before  # pushed further away


def test_memory_cap_and_retrieval():
    a = _agent()
    for i in range(60):
        memory.add_item(a, i, "own_post", f"memory {i}")
    assert len(a["memories"]) == 50
    assert a["memories"][-1]["text"].endswith("59")
    # retrieval: important + recent beats old
    memory.add_item(a, 59, "strong_disagreement", "energy subsidies are wrong")
    top = memory.retrieve(a, 60, query="energy subsidies", k=1)
    assert top and top[0]["kind"] == "strong_disagreement"


def test_relation_weights_and_trust():
    edges: dict = {}
    relations.reaction(edges, "a", "b")
    relations.reaction(edges, "b", "a")
    assert edges["a|b"]["weight"] == pytest.approx(0.08)
    relations.reply(edges, "a", "b", agree=False)
    assert edges["a|b"]["weight"] == pytest.approx(0.0)
    relations.decay(edges, 0.5)
    assert edges["a|b"]["weight"] == pytest.approx(0.0)
    # set_follow + trust
    assert relations.set_follow(edges, "a", "c", True)
    assert relations.trust_in(edges, "a", "c") == pytest.approx(0.5)
    assert relations.trust_in(edges, "a", None) == pytest.approx(0.5)


def test_clamps():
    a = _agent()
    author = {"id": "agent_b"}
    opinion.update_from_post(a, author, _post(value=5.0), ["iss_1"], True, True, False, 1.0)
    assert -1.0 <= a["stances"]["iss_1"]["value"] <= 1.0
