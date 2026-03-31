"""
Class management routes (room-scoped).
"""

from flask import Blueprint, jsonify, request, session

from auth import login_required
from database import get_db
import state

bp = Blueprint("class_routes", __name__)


@bp.route("/api/classes")
def api_classes():
    room_id = session.get("room_id")
    if room_id:
        db = get_db()
        rows = db.execute(
            "SELECT class_name FROM room_classes WHERE room_id = ? ORDER BY class_index",
            (room_id,),
        ).fetchall()
        db.close()
        if rows:
            return jsonify({"classes": [r["class_name"] for r in rows]})
    return jsonify({"classes": state.CLASS_NAMES})


@bp.route("/api/rooms/<int:room_id>/classes")
@login_required
def api_room_classes(room_id):
    db = get_db()
    rows = db.execute(
        "SELECT class_name FROM room_classes WHERE room_id = ? ORDER BY class_index",
        (room_id,),
    ).fetchall()
    db.close()
    classes = [r["class_name"] for r in rows] if rows else ["object"]
    return jsonify({"classes": classes})


@bp.route("/api/rooms/<int:room_id>/classes", methods=["POST"])
@login_required
def api_save_room_classes(room_id):
    data = request.get_json() or {}
    classes = data.get("classes", [])
    if not isinstance(classes, list) or not classes:
        return jsonify({"error": "classes must be a non-empty list"}), 400
    cleaned = [str(c).strip() for c in classes if str(c).strip()]
    if not cleaned:
        return jsonify({"error": "At least one class name required"}), 400

    db = get_db()
    db.execute("DELETE FROM room_classes WHERE room_id = ?", (room_id,))
    for idx, name in enumerate(cleaned):
        db.execute(
            "INSERT INTO room_classes (room_id, class_index, class_name) VALUES (?, ?, ?)",
            (room_id, idx, name),
        )
    db.commit()
    db.close()

    if session.get("room_id") == room_id:
        state.CLASS_NAMES = cleaned

    return jsonify({"status": "ok", "classes": cleaned})
