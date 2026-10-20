"""Call-budget estimate + presets. Shown to the user before Start."""
from __future__ import annotations

import math
from typing import Any

PRESETS: dict[str, dict[str, int]] = {
    "quick": {"agents": 16, "ticks": 12, "writes_per_tick": 4},
    "standard": {"agents": 30, "ticks": 25, "writes_per_tick": 8},
    "large": {"agents": 60, "ticks": 40, "writes_per_tick": 12},
}

PROVIDER_CAPS: dict[str, int | None] = {
    "openrouter": 50,        # unfunded daily cap; 1000 once $10 lifetime credits
    "opencode_zen": None,
    "nvidia_nim": None,
    "kilo": None,
    "fcc": None,
    "tokenharbor": None,
    "custom": None,
    "mock": None,
}


def estimate(config: dict[str, Any], write_batch: int = 3,
             brief_calls: int = 2) -> dict[str, Any]:
    """Calls = brief + persona batches + tick batches + reflections + report, +20% margin."""
    n = int(config.get("agents", 16))
    t = int(config.get("ticks", 12))
    w = int(config.get("writes_per_tick", 4))
    reflect_every = int(config.get("reflect_every", 5) or 0)
    persona = math.ceil(n / 5)
    per_tick = (math.ceil(w / write_batch) if w > 0 else 0)
    reflections = (t // reflect_every) if reflect_every > 0 else 0
    core = brief_calls + persona + t * per_tick + reflections + 1
    margin = math.ceil(core * 1.2)
    return {
        "agents": n, "ticks": t, "writes_per_tick": w,
        "core_calls": core, "max_llm_calls": margin,
        "per_provider": {"brief": brief_calls, "personas": persona,
                         "writing": t * per_tick, "reflections": reflections,
                         "report": 1},
    }


def warnings(config: dict[str, Any], est: dict[str, Any],
             provider: str, rpm: int) -> list[str]:
    msgs: list[str] = []
    cap = PROVIDER_CAPS.get(provider)
    if cap is not None and est["max_llm_calls"] > cap:
        msgs.append(f"Estimate {est['max_llm_calls']} calls exceeds the known {provider} free "
                    f"allowance (~{cap} calls/day). Reduce agents/ticks/writes or use the mock provider.")
    if rpm:
        minutes = est["core_calls"] / rpm
        if minutes > 30:
            msgs.append(f"At {rpm} calls/minute this run needs about {minutes:.0f} minutes of "
                        "provider time. Consider fewer ticks or a higher-RPM provider.")
    return msgs
