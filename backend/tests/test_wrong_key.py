"""M1-D: wrong API key must produce a readable error naming the provider."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client(fresh_db):
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def test_wrong_key_names_provider(client):
    # Set an invalid NVIDIA key
    r = client.put("/api/settings", json={
        "settings": {},
        "keys": {"NVIDIA_API_KEY": "sk-invalid-test-key-000"},
    })
    assert r.status_code == 200, r.text

    # Test connection with the bad key
    r2 = client.post("/api/providers/test",
                     json={"provider": "nvidia_nim"})
    # The gateway returns 200 with error details in body
    assert r2.status_code == 200, r2.text
    body = r2.json()
    assert body.get("auth_ok") is False, f"auth_ok should be False: {r2.text}"
    assert "nvidia" in r2.text.lower() or "nim" in r2.text.lower(), f"provider name missing from error: {r2.text}"


def test_wrong_key_does_not_leak_secret(client):
    r = client.put("/api/settings", json={
        "settings": {},
        "keys": {"NVIDIA_API_KEY": "sk-invalid-test-key-000"},
    })
    assert r.status_code == 200
    assert "sk-invalid-test-key-000" not in r.text