"""
Lightweight in-memory rate limiter.
"""

import threading
import time
from functools import wraps
from flask import jsonify, request


class RateLimiter:
    """Token-bucket rate limiter keyed by IP address."""

    def __init__(self):
        self._buckets = {}  # key -> {"tokens": float, "last": float}
        self._lock = threading.Lock()

    def _get_key(self):
        return request.remote_addr or "unknown"

    def is_allowed(self, max_requests, window_seconds):
        """Check if the current request is within rate limits.

        Uses a simple sliding-window counter approach.
        max_requests: maximum number of requests per window
        window_seconds: time window in seconds
        """
        key = self._get_key()
        now = time.monotonic()

        with self._lock:
            if key not in self._buckets:
                self._buckets[key] = {"count": 1, "window_start": now}
                return True

            bucket = self._buckets[key]
            elapsed = now - bucket["window_start"]

            if elapsed >= window_seconds:
                # Reset window
                bucket["count"] = 1
                bucket["window_start"] = now
                return True

            if bucket["count"] < max_requests:
                bucket["count"] += 1
                return True

            return False

    def cleanup(self, max_age=600):
        """Remove stale entries older than max_age seconds."""
        now = time.monotonic()
        with self._lock:
            stale = [k for k, v in self._buckets.items() if now - v["window_start"] > max_age]
            for k in stale:
                del self._buckets[k]


# Global limiter instances
_auth_limiter = RateLimiter()      # For login/register
_api_limiter = RateLimiter()       # For general API
_heavy_limiter = RateLimiter()     # For expensive ops (export, train, inference)


def rate_limit(max_requests=60, window=60, limiter=None):
    """Decorator to add rate limiting to a route.

    Args:
        max_requests: max requests per window
        window: window in seconds
        limiter: which RateLimiter to use (default: _api_limiter)
    """
    if limiter is None:
        limiter = _api_limiter

    def decorator(f):
        @wraps(f)
        def decorated(*args, **kwargs):
            if not limiter.is_allowed(max_requests, window):
                return jsonify({"error": "Too many requests. Please try again later."}), 429
            return f(*args, **kwargs)
        return decorated
    return decorator


# Pre-configured decorators
def auth_rate_limit(f):
    """Rate limit for auth endpoints: 10 requests per 60 seconds."""
    return rate_limit(max_requests=10, window=60, limiter=_auth_limiter)(f)


def heavy_rate_limit(f):
    """Rate limit for expensive operations: 5 requests per 60 seconds."""
    return rate_limit(max_requests=5, window=60, limiter=_heavy_limiter)(f)
