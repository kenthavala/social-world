"""Pydantic models used to validate LLM output at the boundary."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator


class EssayOut(BaseModel):
    """The LLM-written executive summary of a finished report.

    The ONLY generated part of the report: every other number in the report is
    counted from recorded rows. Sections are 1-3 sentences each, grounded ONLY
    in the counted-facts JSON the gateway prompt supplies.
    """
    executive_summary: str = Field(min_length=10)
    opinion_shifts: str = ""
    emerging_narratives: str = ""
    influential_agents: str = ""
    communities: str = ""
    key_events: str = ""
    contradictions: str = ""
    unexpected_outcomes: str = ""
    limitations: str = ""

    @field_validator("*", mode="before")
    @classmethod
    def _trim(cls, v: Any) -> str:
        if v is None:
            return ""
        return str(v).strip()[:1200]


class Big5(BaseModel):
    openness: float = 0.5
    conscientiousness: float = 0.5
    extraversion: float = 0.5
    agreeableness: float = 0.5
    neuroticism: float = 0.5

    @field_validator("*", mode="before")
    @classmethod
    def _clamp(cls, v: Any) -> float:
        try:
            return max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return 0.5


class PersonaOut(BaseModel):
    name: str = Field(default="")
    handle: str = ""
    bio: str = ""
    archetype: str = "ordinary user"
    big5: Big5 = Field(default_factory=Big5)
    goals: list[str] = []
    interests: list[str] = []
    voice: str = ""
    stances: dict[str, Any] = {}

    @field_validator("name", mode="before")
    @classmethod
    def _name(cls, v: Any) -> str:
        return str(v or "Unnamed")[:60]

    @field_validator("goals", "interests", mode="before")
    @classmethod
    def _strlist(cls, v: Any) -> list[str]:
        if isinstance(v, str):
            v = [v]
        return [str(x)[:60] for x in (v or []) if str(x).strip()][:10]


class WriteItem(BaseModel):
    agent_id: str
    action: str = "post"
    reply_to: Optional[str] = None
    text: str = ""
    stance: dict[str, Any] = {}
    emotion: str = "neutral"
    cited_chunk_ids: list[str] = []

    @field_validator("agent_id", mode="before")
    @classmethod
    def _aid(cls, v: Any) -> str:
        return str(v or "").strip()[:40]

    @field_validator("action", mode="before")
    @classmethod
    def _action(cls, v: Any) -> str:
        v = str(v or "post").lower()
        return v if v in ("post", "reply") else "post"

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: Any) -> str:
        return str(v or "").strip()[:600]


class ReflectItem(BaseModel):
    agent_id: str
    belief_summary: str

    @field_validator("belief_summary", mode="before")
    @classmethod
    def _bs(cls, v: Any) -> str:
        return str(v or "").strip()[:400]


class ReportOut(BaseModel):
    executive_summary: str = ""
    opinion_shifts: str = ""
    emerging_narratives: str = ""
    influential_agents: str = ""
    communities: str = ""
    key_events: str = ""
    contradictions: str = ""
    unexpected_outcomes: str = ""
    limitations: str = ""
