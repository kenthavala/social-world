"""Provider presets. A provider is a preset row; adding one means adding a row here."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

@dataclass(frozen=True)
class Preset:
    name: str
    wire_format: str                      # openai_chat | anthropic_messages
    base_url: str
    key_env: Optional[str]                # env var holding the key
    default_rpm: int
    notes: str = ""
    extra_headers: dict = field(default_factory=dict)


PRESETS: dict[str, Preset] = {
    "openrouter": Preset(
        "openrouter", "openai_chat", "https://openrouter.ai/api/v1",
        "OPENROUTER_API_KEY", 15,
        "Free tier: 50 requests/day until $10 lifetime credits bought, then 1000/day.",
        {"HTTP-Referer": "http://localhost", "X-Title": "OASIS-Lite"},
    ),
    "opencode_zen": Preset(
        "opencode_zen", "openai_chat", "https://opencode.ai/zen/v1",
        "OPENCODE_API_KEY", 20,
        "Some models speak Anthropic /messages; the gateway retries with that wire format "
        "if the error indicates a wrong endpoint. /responses-only models are not supported.",
    ),
    "nvidia_nim": Preset(
        "nvidia_nim", "openai_chat", "https://integrate.api.nvidia.com/v1",
        "NVIDIA_API_KEY", 35, "Model IDs look like vendor/model.",
    ),
    "kilo": Preset(
        "kilo", "openai_chat", "https://api.kilo.ai/api/gateway",
        "KILOCODE_API_KEY", 3, "RPM set conservatively; free model IDs end in :free.",
    ),
    "fcc": Preset(
        "fcc", "anthropic_messages", "http://127.0.0.1:8082/v1",
        "FCC_API_KEY", 0,  # rpm filled from config at call time
        "Local free-claude-code proxy. Start fcc-server if the connection is refused.",
    ),
    "tokenharbor": Preset(
        "tokenharbor", "openai_chat", "https://tokenharbor.ai/v1",
        "TOKENHARBOR_API_KEY", 10,
        "Free models must be enabled in the Token Harbor dashboard first.",
    ),
    "custom": Preset(
        "custom", "openai_chat", "", "LLM_API_KEY", 15,
        "Any OpenAI- or Anthropic-compatible endpoint (local Ollama/LM Studio). "
        "Set LLM_BASE_URL and LLM_WIRE_FORMAT.",
    ),
    "mock": Preset(
        "mock", "none", "", None, 0,
        "Deterministic fake responses for tests and offline demos.",
    ),
}


def get_preset(name: str) -> Optional[Preset]:
    return PRESETS.get((name or "").strip().lower())
