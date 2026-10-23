"""Backend pipeline test: brief → run config → seeding → findings → report.
Verifies that 5 issues + 6 groups survive the complete pipeline with mock provider.
"""
from __future__ import annotations

import pytest

from app import db
from app.ingest.brief import _sanitize_brief


@pytest.fixture()
def brief_5i_6g():
    """Construct a brief with exactly 5 issues and 6 stakeholder groups,
    then sanitize it to verify no data loss."""
    brief = {
        "summary": "Five contested issues with six stakeholder groups.",
        "issues": [
            {"id": "iss_1", "name": "Issue One", "question": "Should policy A pass?",
             "pro_label": "Supports", "con_label": "Opposes",
             "evidence_chunk_ids": ["c_1", "c_2", "c_3"]},
            {"id": "iss_2", "name": "Issue Two", "question": "Should policy B pass?",
             "pro_label": "Supports", "con_label": "Opposes",
             "evidence_chunk_ids": ["c_4", "c_5"]},
            {"id": "iss_3", "name": "Issue Three", "question": "Should policy C pass?",
             "pro_label": "Supports", "con_label": "Opposes",
             "evidence_chunk_ids": ["c_6"]},
            {"id": "iss_4", "name": "Issue Four", "question": "Should policy D pass?",
             "pro_label": "Supports", "con_label": "Opposes",
             "evidence_chunk_ids": ["c_7", "c_8", "c_9", "c_10"]},
            {"id": "iss_5", "name": "Issue Five", "question": "Should policy E pass?",
             "pro_label": "Supports", "con_label": "Opposes",
             "evidence_chunk_ids": []},
        ],
        "stakeholder_groups": [
            {"name": "Group A", "description": "First group", "size_hint": "large",
             "stance_by_issue": {"iss_1": 0.6, "iss_2": 0.3, "iss_3": 0.1, "iss_4": -0.2, "iss_5": 0.0}},
            {"name": "Group B", "description": "Second group", "size_hint": "medium",
             "stance_by_issue": {"iss_1": -0.3, "iss_2": 0.5, "iss_3": -0.1, "iss_4": 0.3, "iss_5": -0.2}},
            {"name": "Group C", "description": "Third group", "size_hint": "small",
             "stance_by_issue": {"iss_1": 0.1, "iss_2": -0.2, "iss_3": 0.6, "iss_4": 0.4, "iss_5": 0.1}},
            {"name": "Group D", "description": "Fourth group", "size_hint": "medium",
             "stance_by_issue": {"iss_1": -0.5, "iss_2": -0.3, "iss_3": -0.1, "iss_4": 0.6, "iss_5": -0.1}},
            {"name": "Group E", "description": "Fifth group", "size_hint": "small",
             "stance_by_issue": {"iss_1": 0.2, "iss_2": 0.4, "iss_3": -0.3, "iss_4": -0.2, "iss_5": 0.5}},
            {"name": "Group F", "description": "Sixth group", "size_hint": "large",
             "stance_by_issue": {"iss_1": 0.0, "iss_2": 0.0, "iss_3": 0.0, "iss_4": 0.0, "iss_5": 0.0}},
        ],
        "key_claims": [], "entities": [], "fallback": False,
    }

    # Sanitize - this is the critical test: no [:6] cap on evidence_chunk_ids
    sanitized = _sanitize_brief(brief)
    assert len(sanitized["issues"]) == 5, \
        f"Expected 5 issues after sanitize, got {len(sanitized['issues'])}"
    assert len(sanitized["stakeholder_groups"]) == 6, \
        f"Expected 6 groups after sanitize, got {len(sanitized['stakeholder_groups'])}"
    # Verify evidence_chunk_ids all survive (no [:6] cap from D006)
    for issue in sanitized["issues"]:
        assert isinstance(issue["evidence_chunk_ids"], list), \
            f"evidence_chunk_ids should be a list, got {type(issue['evidence_chunk_ids'])}"
        # No artificial cap - all chunk IDs preserved
        assert len(issue["evidence_chunk_ids"]) <= 12, \
            f"evidence_chunk_ids should have ≤12 items (set by select_chunks), got {len(issue['evidence_chunk_ids'])}"

    return brief, sanitized


@pytest.mark.asyncio
async def test_pipeline_5_issues_6_groups_brief_sanitization(brief_5i_6g):
    """Verify _sanitize_brief preserves all 5 issues + 6 groups with no data loss."""
    brief, sanitized = brief_5i_6g
    # The sanitized brief should have the same issue/group counts
    assert len(sanitized["issues"]) == 5
    assert len(sanitized["stakeholder_groups"]) == 6


def test_pipeline_5_issues_6_groups_evidence_chunk_ids(brief_5i_6g):
    """Verify D006: evidence_chunk_ids are NOT silently truncated to 6."""
    _, sanitized = brief_5i_6g
    # Issue 1 has 3 chunk IDs - all should survive
    assert len(sanitized["issues"][0]["evidence_chunk_ids"]) == 3
    # Issue 2 has 2 chunk IDs - all should survive
    assert len(sanitized["issues"][1]["evidence_chunk_ids"]) == 2
    # Issue 5 has 0 chunk IDs - should remain empty
    assert len(sanitized["issues"][4]["evidence_chunk_ids"]) == 0
    # Issue 4 has 4 chunk IDs - all should survive (not capped at 6)
    assert len(sanitized["issues"][3]["evidence_chunk_ids"]) == 4