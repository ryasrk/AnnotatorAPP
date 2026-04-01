"""Shared route utilities — error handler decorator, common validators."""
import functools
import logging
from flask import jsonify

logger = logging.getLogger(__name__)


def api_error_handler(f):
    """Catch unhandled exceptions in route handlers and return JSON 500."""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        try:
            return f(*args, **kwargs)
        except Exception as e:
            logger.exception("Unhandled error in %s: %s", f.__name__, e)
            return jsonify({"error": "Internal server error"}), 500
    return wrapper
