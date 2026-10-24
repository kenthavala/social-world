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


def test_stance_inertia_factor_is_documented_and_symmetric():
    assert opinion.INERTIA == 0.5
    assert opinion.inertia_factor(0.0) == pytest.approx(1.0)
    assert opinion.inertia_factor(0.5) == pytest.approx(0.75)
    assert opinion.inertia_factor(1.0) == pytest.approx(0.5)
    assert opinion.inertia_factor(-1.0) == pytest.approx(0.5)
    # Monotone in |stance| and never zero (movement is slowed, not frozen).
    values = [opinion.inertia_factor(x / 10) for x in range(0, 11)]
    assert values == sorted(values, reverse=True)
    assert min(values) == pytest.approx(0.5)


def test_extreme_stance_moves_less_than_a_centrist():
    centrist = _agent(stances={"iss_1": {"value": 0.0, "confidence": 0.5}})
    committed = _agent(stances={"iss_1": {"value": 0.8, "confidence": 0.5}})
    for a in (centrist, committed):
        opinion.update_from_post(a, {"id": "agent_b"}, _post(value=1.0), ["iss_1"],
                                 liked=False, replied=False, backfire_enabled=True,
                                 edge_weight=0.5)
    centrist_delta = centrist["stances"]["iss_1"]["value"]
    committed_delta = committed["stances"]["iss_1"]["value"] - 0.8
    # delta = RATE * 0.4 * trust(0.5) * (1 - stubbornness) * inertia * (post - current)
    base = opinion.RATE * 0.4 * (0.5 + 0.5 * 0.5) * (1 - 0.3)
    assert centrist_delta == pytest.approx(base * 1.0, rel=1e-6)
    assert committed_delta == pytest.approx(base * opinion.inertia_factor(0.8) * 0.2, abs=5e-5)
    assert opinion.inertia_factor(0.8) < 1.0


def test_backfire_is_not_scaled_by_inertia():
    a = _agent(stances={"iss_1": {"value": -0.5, "confidence": 0.5}},
               traits={"tolerance": 0.2, "stubbornness": 0.3})
    opinion.update_from_post(a, {"id": "agent_b"}, _post(value=0.9), ["iss_1"],
                             liked=False, replied=False, backfire_enabled=True,
                             edge_weight=-0.5)
    # Exact backfire step: -0.03, independent of |current stance|.
    assert a["stances"]["iss_1"]["value"] == pytest.approx(-0.53)
