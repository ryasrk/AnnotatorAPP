"""
Room routes: CRUD, join, enter, info.
"""

import uuid
from pathlib import Path

from flask import Blueprint, jsonify, request, session

from auth import login_required, get_current_user
from database import get_db
from extensions import socketio
from services.image_service import reload_dataset
import state

bp = Blueprint("room_routes", __name__)


@bp.route("/api/rooms")
@login_required
def api_rooms():
    db = get_db()
    rooms = db.execute("""
        SELECT r.*, u.username AS creator_name,
            (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count
        FROM rooms r
        JOIN room_members rm ON rm.room_id = r.id
        LEFT JOIN users u ON r.created_by = u.id
        WHERE rm.user_id = ?
        ORDER BY rm.joined_at DESC
    """, (session["user_id"],)).fetchall()
    db.close()
    return jsonify({"rooms": [dict(r) for r in rooms]})


@bp.route("/api/rooms/create", methods=["POST"])
@login_required
def api_create_room():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Room name required"}), 400

    code = uuid.uuid4().hex[:6].upper()
    db = get_db()
    cursor = db.execute(
        "INSERT INTO rooms (code, name, created_by) VALUES (?, ?, ?)",
        (code, name, session["user_id"]),
    )
    room_id = cursor.lastrowid
    db.execute(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)",
        (room_id, session["user_id"]),
    )
    db.commit()
    db.close()
    return jsonify({"status": "ok", "room_id": room_id, "code": code, "name": name})


@bp.route("/api/rooms/<int:room_id>", methods=["DELETE"])
@login_required
def api_delete_room(room_id):
    user_id = session["user_id"]
    db = get_db()
    room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not room:
        db.close()
        return jsonify({"error": "Room not found"}), 404
    if room["created_by"] != user_id:
        db.close()
        return jsonify({"error": "Only the room creator can delete the room"}), 403
    db.execute("DELETE FROM image_edits WHERE room_id = ?", (room_id,))
    db.execute("DELETE FROM image_assignments WHERE room_id = ?", (room_id,))
    db.execute("DELETE FROM image_reviews WHERE room_id = ?", (room_id,))
    db.execute("DELETE FROM room_classes WHERE room_id = ?", (room_id,))
    db.execute("DELETE FROM messages WHERE room_id = ?", (room_id,))
    db.execute("DELETE FROM room_members WHERE room_id = ?", (room_id,))
    db.execute("DELETE FROM rooms WHERE id = ?", (room_id,))
    db.commit()
    db.close()
    return jsonify({"ok": True})


@bp.route("/api/rooms/join", methods=["POST"])
@login_required
def api_join_room():
    data = request.get_json() or {}
    code = data.get("code", "").strip().upper()
    if not code:
        return jsonify({"error": "Room code required"}), 400

    db = get_db()
    room = db.execute("SELECT * FROM rooms WHERE code = ?", (code,)).fetchone()
    if not room:
        db.close()
        return jsonify({"error": "Room not found"}), 404

    existing = db.execute(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?",
        (room["id"], session["user_id"]),
    ).fetchone()
    if not existing:
        db.execute(
            "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)",
            (room["id"], session["user_id"]),
        )
        db.commit()
    db.close()
    return jsonify({"status": "ok", "room_id": room["id"], "code": code, "name": room["name"]})


@bp.route("/api/rooms/<int:room_id>")
@login_required
def api_room_info(room_id):
    db = get_db()
    room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not room:
        db.close()
        return jsonify({"error": "Room not found"}), 404

    members = db.execute("""
        SELECT u.id, u.username, u.display_name, u.color, rm.joined_at
        FROM users u JOIN room_members rm ON rm.user_id = u.id
        WHERE rm.room_id = ?
    """, (room_id,)).fetchall()
    db.close()
    return jsonify({"room": dict(room), "members": [dict(m) for m in members]})


@bp.route("/api/rooms/<int:room_id>/enter", methods=["POST"])
@login_required
def api_enter_room(room_id):
    db = get_db()
    member = db.execute(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?",
        (room_id, session["user_id"]),
    ).fetchone()
    if not member:
        db.close()
        return jsonify({"error": "Not a member of this room"}), 403

    room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    db.close()
    if not room:
        return jsonify({"error": "Room not found"}), 404

    state.CURRENT_ROOM_ID = room_id
    session["room_id"] = room_id

    if room["images_dir"]:
        state.RAW_IMAGES_DIR = Path(room["images_dir"])
        state.RAW_LABELS_DIR = Path(room["labels_dir"]) if room["labels_dir"] else state.RAW_IMAGES_DIR.parent / "labels"
        state.EXPORT_DIR = Path(room["export_dir"]) if room["export_dir"] else state.RAW_IMAGES_DIR.parent / "export"
        reload_dataset()
    else:
        state.RAW_IMAGES_DIR = Path("/tmp/nexus-blank")
        state.RAW_LABELS_DIR = Path("/tmp/nexus-blank")
        state.RAW_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        with state.state_lock:
            state.image_cache.clear()
            state.image_names = []
            state.cache_ready = True

    # Load room classes
    db2 = get_db()
    classes_rows = db2.execute(
        "SELECT class_name FROM room_classes WHERE room_id = ? ORDER BY class_index",
        (room_id,),
    ).fetchall()
    db2.close()
    room_classes = [r["class_name"] for r in classes_rows] if classes_rows else ["object"]

    state.CLASS_NAMES = room_classes

    return jsonify({
        "status": "ok", "room_id": room_id,
        "room_name": room["name"], "room_code": room["code"],
        "images_dir": str(state.RAW_IMAGES_DIR), "labels_dir": str(state.RAW_LABELS_DIR),
        "export_dir": str(state.EXPORT_DIR), "image_count": len(state.image_names),
        "blank": not bool(room["images_dir"]),
        "classes": room_classes,
    })
