"""
Chat and online-user routes.
"""

from datetime import datetime

from flask import Blueprint, jsonify, request

from auth import login_required, get_current_user
from database import get_db
from extensions import socketio
import state

bp = Blueprint("chat_routes", __name__)


@bp.route("/api/rooms/<int:room_id>/online")
@login_required
def api_room_online(room_id):
    with state.online_lock:
        online = [
            {"user_id": u["user_id"], "username": u["username"],
             "display_name": u["display_name"], "color": u["color"]}
            for u in state.online_users.values()
            if u.get("room_id") == room_id
        ]
    return jsonify({"online": online})


@bp.route("/api/rooms/online-counts")
@login_required
def api_rooms_online_counts():
    with state.online_lock:
        counts = {}
        for u in state.online_users.values():
            rid = u.get("room_id")
            if rid:
                counts[rid] = counts.get(rid, 0) + 1
    return jsonify({"counts": counts})


@bp.route("/api/rooms/<int:room_id>/messages")
@login_required
def api_room_messages(room_id):
    msg_type = request.args.get("type", "global")
    limit = min(int(request.args.get("limit", 100)), 200)
    before_id = request.args.get("before")
    user = get_current_user()
    db = get_db()

    if msg_type == "dm":
        with_user = request.args.get("with_user")
        if not with_user:
            db.close()
            return jsonify({"error": "with_user required for DM"}), 400
        query = """
            SELECT m.id, m.message, m.msg_type, m.created_at,
                   m.sender_id, m.recipient_id,
                   u.username AS sender_username, u.display_name AS sender_display_name, u.color AS sender_color
            FROM messages m JOIN users u ON m.sender_id = u.id
            WHERE m.room_id = ? AND m.msg_type = 'dm'
              AND ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
        """
        params = [room_id, user["id"], int(with_user), int(with_user), user["id"]]
    else:
        query = """
            SELECT m.id, m.message, m.msg_type, m.created_at,
                   m.sender_id, m.recipient_id,
                   u.username AS sender_username, u.display_name AS sender_display_name, u.color AS sender_color
            FROM messages m JOIN users u ON m.sender_id = u.id
            WHERE m.room_id = ? AND m.msg_type = 'global'
        """
        params = [room_id]

    if before_id:
        query += " AND m.id < ?"
        params.append(int(before_id))

    query += " ORDER BY m.id DESC LIMIT ?"
    params.append(limit)

    rows = db.execute(query, params).fetchall()
    db.close()

    messages = [
        {
            "id": r["id"], "message": r["message"], "msg_type": r["msg_type"],
            "created_at": r["created_at"], "sender_id": r["sender_id"],
            "recipient_id": r["recipient_id"],
            "sender_username": r["sender_username"],
            "sender_display_name": r["sender_display_name"],
            "sender_color": r["sender_color"],
        }
        for r in reversed(rows)
    ]
    return jsonify({"messages": messages})


@bp.route("/api/rooms/<int:room_id>/messages", methods=["POST"])
@login_required
def api_room_send_message(room_id):
    user = get_current_user()
    data = request.get_json()
    message = (data.get("message") or "").strip()
    if not message or len(message) > 2000:
        return jsonify({"error": "Message must be 1-2000 characters"}), 400

    msg_type = data.get("type", "global")
    recipient_id = data.get("recipient_id")

    if msg_type == "dm" and not recipient_id:
        return jsonify({"error": "recipient_id required for DM"}), 400

    db = get_db()
    cur = db.execute(
        "INSERT INTO messages (room_id, sender_id, recipient_id, message, msg_type) VALUES (?, ?, ?, ?, ?)",
        (room_id, user["id"], recipient_id, message, msg_type),
    )
    msg_id = cur.lastrowid
    db.commit()
    db.close()

    msg_payload = {
        "id": msg_id,
        "room_id": room_id,
        "message": message,
        "msg_type": msg_type,
        "sender_id": user["id"],
        "sender_username": user["username"],
        "sender_display_name": user["display_name"],
        "sender_color": user["color"],
        "recipient_id": recipient_id,
        "created_at": datetime.now().isoformat(),
    }

    room_name = f"room_{room_id}"
    if msg_type == "dm":
        with state.online_lock:
            for sid, u in state.online_users.items():
                if u.get("room_id") == room_id and u["user_id"] in (user["id"], recipient_id):
                    socketio.emit("chat_message", msg_payload, room=sid)
    else:
        socketio.emit("chat_message", msg_payload, room=room_name)

    return jsonify({"id": msg_id, "status": "sent"})
