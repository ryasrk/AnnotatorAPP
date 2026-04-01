"""
Flask extensions — initialized here, attached to app in factory.
"""

import os
from flask_socketio import SocketIO

# Restrict CORS to configured origins (default: same-origin only)
_cors_origins = os.environ.get("CORS_ORIGINS", "").strip()
cors_allowed = _cors_origins.split(",") if _cors_origins else []

socketio = SocketIO(cors_allowed_origins=cors_allowed or None, async_mode="threading")
