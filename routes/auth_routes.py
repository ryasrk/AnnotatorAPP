"""
Auth routes: register, login, logout, me.
"""

from flask import Blueprint, jsonify, request, session
from werkzeug.security import generate_password_hash, check_password_hash

from config import USER_COLORS
from database import get_db

bp = Blueprint("auth_routes", __name__)


@bp.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    display_name = data.get("display_name", "").strip() or username

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters"}), 400
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400

    db = get_db()
    if db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
        db.close()
        return jsonify({"error": "Username already taken"}), 400

    count = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    color = USER_COLORS[count % len(USER_COLORS)]
    pw_hash = generate_password_hash(password)

    cursor = db.execute(
        "INSERT INTO users (username, password_hash, display_name, color) VALUES (?, ?, ?, ?)",
        (username, pw_hash, display_name, color),
    )
    user_id = cursor.lastrowid
    db.commit()
    db.close()

    session["user_id"] = user_id
    return jsonify({
        "status": "ok", "user_id": user_id,
        "username": username, "display_name": display_name, "color": color,
    })


@bp.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    db.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid username or password"}), 401

    session["user_id"] = user["id"]
    return jsonify({
        "status": "ok", "user_id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "color": user["color"],
    })


@bp.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"status": "ok"})


@bp.route("/api/me")
def api_me():
    from auth import get_current_user
    user = get_current_user()
    if not user:
        return jsonify({"logged_in": False})
    return jsonify({
        "logged_in": True, "user_id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "color": user["color"],
    })
