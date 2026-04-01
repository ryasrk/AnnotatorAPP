"""
Room routes: CRUD, join, enter, info.
"""

import uuid
from pathlib import Path

from flask import Blueprint, jsonify, request, session

from auth import login_required, get_current_user
from config import BASE_DIR
from database import get_db, get_db_ctx
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

    is_private = 1 if data.get("is_private", False) else 0
    code = uuid.uuid4().hex[:6].upper()
    db = get_db()
    cursor = db.execute(
        "INSERT INTO rooms (code, name, is_private, created_by) VALUES (?, ?, ?, ?)",
        (code, name, is_private, session["user_id"]),
    )
    room_id = cursor.lastrowid
    db.execute(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)",
        (room_id, session["user_id"]),
    )
    db.commit()
    db.close()
    return jsonify({"status": "ok", "room_id": room_id, "code": code, "name": name, "is_private": bool(is_private)})


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
    db.execute("DELETE FROM join_requests WHERE room_id = ?", (room_id,))
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

    user_id = session["user_id"]

    existing = db.execute(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?",
        (room["id"], user_id),
    ).fetchone()
    if existing:
        db.close()
        return jsonify({"status": "ok", "room_id": room["id"], "code": code, "name": room["name"]})

    # Private room — create join request
    if room["is_private"]:
        existing_req = db.execute(
            "SELECT * FROM join_requests WHERE room_id = ? AND user_id = ?",
            (room["id"], user_id),
        ).fetchone()
        if existing_req:
            status = existing_req["status"]
            db.close()
            if status == "pending":
                return jsonify({"status": "pending", "message": "Your join request is pending approval"}), 202
            elif status == "denied":
                return jsonify({"error": "Your join request was denied"}), 403
        db.execute(
            "INSERT OR REPLACE INTO join_requests (room_id, user_id, status) VALUES (?, ?, 'pending')",
            (room["id"], user_id),
        )
        db.commit()
        db.close()

        # Notify room creator
        user = get_current_user()
        socketio.emit("join_request", {
            "room_id": room["id"],
            "user_id": user_id,
            "username": user["username"],
            "display_name": user["display_name"],
        }, room=f"room_{room['id']}")

        return jsonify({"status": "pending", "message": "Join request sent. Waiting for approval."}), 202

    # Public room — immediate join
    db.execute(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)",
        (room["id"], user_id),
    )
    db.commit()
    db.close()
    return jsonify({"status": "ok", "room_id": room["id"], "code": code, "name": room["name"]})


@bp.route("/api/rooms/<int:room_id>/join-requests")
@login_required
def api_join_requests(room_id):
    """List pending join requests (creator only)."""
    db = get_db()
    room = db.execute("SELECT created_by FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not room or room["created_by"] != session["user_id"]:
        db.close()
        return jsonify({"error": "Only room creator can view requests"}), 403

    requests = db.execute("""
        SELECT jr.id, jr.user_id, jr.status, jr.created_at,
               u.username, u.display_name, u.color
        FROM join_requests jr JOIN users u ON jr.user_id = u.id
        WHERE jr.room_id = ? AND jr.status = 'pending'
        ORDER BY jr.created_at ASC
    """, (room_id,)).fetchall()
    db.close()
    return jsonify({"requests": [dict(r) for r in requests]})


@bp.route("/api/rooms/<int:room_id>/join-requests/<int:request_id>", methods=["POST"])
@login_required
def api_resolve_join_request(room_id, request_id):
    """Approve or deny a join request (creator only)."""
    data = request.get_json() or {}
    action = data.get("action", "")
    if action not in ("approve", "deny"):
        return jsonify({"error": "action must be 'approve' or 'deny'"}), 400

    db = get_db()
    room = db.execute("SELECT created_by FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not room or room["created_by"] != session["user_id"]:
        db.close()
        return jsonify({"error": "Only room creator can manage requests"}), 403

    jr = db.execute("SELECT * FROM join_requests WHERE id = ? AND room_id = ?", (request_id, room_id)).fetchone()
    if not jr:
        db.close()
        return jsonify({"error": "Request not found"}), 404

    new_status = "approved" if action == "approve" else "denied"
    db.execute(
        "UPDATE join_requests SET status = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?",
        (new_status, session["user_id"], request_id),
    )

    if action == "approve":
        db.execute(
            "INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)",
            (room_id, jr["user_id"]),
        )

    db.commit()
    db.close()

    # Notify the requesting user
    socketio.emit("join_request_resolved", {
        "room_id": room_id,
        "status": new_status,
        "user_id": jr["user_id"],
    })

    return jsonify({"ok": True, "status": new_status})


@bp.route("/api/rooms/<int:room_id>/privacy", methods=["POST"])
@login_required
def api_update_room_privacy(room_id):
    """Toggle room privacy (creator only)."""
    data = request.get_json() or {}
    is_private = 1 if data.get("is_private", False) else 0

    db = get_db()
    room = db.execute("SELECT created_by FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not room or room["created_by"] != session["user_id"]:
        db.close()
        return jsonify({"error": "Only room creator can change privacy"}), 403

    db.execute("UPDATE rooms SET is_private = ? WHERE id = ?", (is_private, room_id))
    db.commit()
    db.close()
    return jsonify({"ok": True, "is_private": bool(is_private)})


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

    session["room_id"] = room_id

    # Build per-room state
    if room["images_dir"]:
        images_dir = Path(room["images_dir"])
        labels_dir = Path(room["labels_dir"]) if room["labels_dir"] else images_dir.parent / "labels"
        export_dir = Path(room["export_dir"]) if room["export_dir"] else images_dir.parent / "export"
    else:
        images_dir = BASE_DIR
        labels_dir = BASE_DIR
        export_dir = BASE_DIR

    # Load room classes
    db2 = get_db()
    classes_rows = db2.execute(
        "SELECT class_name FROM room_classes WHERE room_id = ? ORDER BY class_index",
        (room_id,),
    ).fetchall()
    db2.close()
    room_classes = [r["class_name"] for r in classes_rows] if classes_rows else ["object"]

    # Create/update per-room state
    rs = state.RoomState(
        room_id=room_id,
        images_dir=images_dir,
        labels_dir=labels_dir,
        export_dir=export_dir,
        class_names=room_classes,
    )
    state.set_room_state(room_id, rs)

    # Sync to legacy globals for backward compat
    state.sync_globals_from_room(room_id)

    if room["images_dir"]:
        reload_dataset()
    else:
        with state.state_lock:
            state.image_cache.clear()
            state.image_names = []
            state.cache_ready = True
            rs.image_names = []
            rs.image_cache = {}
            rs.cache_ready = True

    return jsonify({
        "status": "ok", "room_id": room_id,
        "room_name": room["name"], "room_code": room["code"],
        "is_private": bool(room["is_private"]),
        "created_by": room["created_by"],
        "images_dir": str(images_dir), "labels_dir": str(labels_dir),
        "export_dir": str(export_dir), "image_count": len(state.image_names),
        "blank": not bool(room["images_dir"]),
        "classes": room_classes,
    })
