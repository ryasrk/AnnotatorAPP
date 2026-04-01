"""
Nexus Annotator — Multi-user YOLO Annotation & Training Platform
=================================================================
Application factory and entrypoint.
"""

import threading

from flask import Flask, render_template, jsonify

import config
from extensions import socketio
from database import init_db
from routes import register_blueprints
from sockets.events import register_socket_events
from services.image_service import index_images, build_cache
import state


def create_app():
    app = Flask(__name__)
    app.secret_key = config.SECRET_KEY
    app.config["SESSION_COOKIE_HTTPONLY"] = config.SESSION_COOKIE_HTTPONLY
    app.config["SESSION_COOKIE_SAMESITE"] = config.SESSION_COOKIE_SAMESITE

    # Initialize extensions
    socketio.init_app(app)

    # CSRF protection for state-changing requests
    @app.before_request
    def csrf_protect():
        from flask import request
        if request.method in ("POST", "PUT", "DELETE", "PATCH"):
            # Allow requests with JSON content-type (custom header = CORS preflight required)
            ct = request.content_type or ""
            if "application/json" not in ct and request.path.startswith("/api/"):
                return jsonify({"error": "Content-Type must be application/json"}), 400

    # Security headers
    @app.after_request
    def set_security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        return response

    # Register blueprints
    register_blueprints(app)

    # Register socket events
    register_socket_events(socketio)

    # Index page
    @app.route("/")
    def index():
        return render_template("index.html", class_names=state.CLASS_NAMES)

    return app


if __name__ == "__main__":
    app = create_app()

    init_db()
    state.load_class_config()

    print(f"[CONFIG] Images: {state.RAW_IMAGES_DIR}")
    print(f"[CONFIG] Labels: {state.RAW_LABELS_DIR}")
    print(f"[CONFIG] Export: {state.EXPORT_DIR}")
    print(f"[CONFIG] Classes: {state.CLASS_NAMES}")

    index_images()
    threading.Thread(target=build_cache, daemon=True).start()

    socketio.run(app, host=config.HOST, port=config.PORT, debug=False, allow_unsafe_werkzeug=True)
