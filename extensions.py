"""
Flask extensions — initialized here, attached to app in factory.
"""

from flask_socketio import SocketIO

socketio = SocketIO(cors_allowed_origins="*", async_mode="threading")
