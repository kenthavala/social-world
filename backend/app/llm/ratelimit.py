"""Async token bucket (RPM) + global concurrency semaphore per call site."""
from __future__ import annotations

import asyncio
import time


class TokenBucket:
    def __init__(self, rpm: int):
        self.rpm = max(1, rpm)
        self.capacity = float(max(1, rpm))
        self.tokens = self.capacity
        self.rate = self.capacity / 60.0
        self.updated = time.monotonic()
        self._lock = asyncio.Lock()

    def set_rpm(self, rpm: int) -> None:
        self.rpm = max(1, rpm)
        self.capacity = float(self.rpm)
        self.rate = self.capacity / 60.0

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1.0:
                    self.tokens -= 1.0
                    return
                wait = (1.0 - self.tokens) / self.rate
                await asyncio.sleep(min(wait, 5.0))


class RateLimiter:
    """One bucket per provider; plus a global semaphore for concurrent requests."""

    def __init__(self):
        self._buckets: dict[str, TokenBucket] = {}
        self._buckets_lock = asyncio.Lock()
        self._semaphores: dict[str, asyncio.Semaphore] = {}
        self.last_wait_seconds: float = 0.0

    async def acquire(self, provider: str, rpm: int, concurrency: int) -> None:
        async with self._buckets_lock:
            if provider not in self._buckets:
                self._buckets[provider] = TokenBucket(rpm)
                self._semaphores[provider] = asyncio.Semaphore(concurrency)
        bucket = self._buckets[provider]
        start = time.monotonic()
        await bucket.acquire()
        waited = time.monotonic() - start
        if waited > self.last_wait_seconds:
            self.last_wait_seconds = waited
        await self._semaphores[provider].acquire()

    def release(self, provider: str) -> None:
        if provider in self._semaphores:
            self._semaphores[provider].release()


rate_limiter = RateLimiter()
