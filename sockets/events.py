"""
WebSocket event handlers: connect, disconnect, room join/leave, cursor, training.
"""

from flask import request
from flask_socketio import emit, join_room, leave_room

from auth import get_current_user
from extensions import socketio
import state


def register_socket_events(sio):
    @sio.on("connect")
    def ws_connect():
        user = get_current_user()
        if user:
            with state.online_lock:
                state.online_users[request.sid] = {
                    "user_id": user["id"],
                    "username": user["username"],
                    "display_name": user["display_name"],
                    "color": user["color"],
                    "room_id": None,
                }
        print(f"[WS] Connected: {request.sid}")

    @sio.on("disconnect")
    def ws_disconnect():
        with state.online_lock:
            info = state.online_users.pop(request.sid, None)
        if info and info.get("room_id"):
            room_name = f"room_{info['room_id']}"
            emit("user_left", {
                "username": info["username"],
                "display_name": info["display_name"],
            }, room=room_name)
            _broadcast_online(info["room_id"])
        print(f"[WS] Disconnected: {request.sid}")

    @sio.on("join_room")
    def ws_join_room(data):
        room_id = data.get("room_id")
        if room_id:
            room_name = f"room_{room_id}"
            join_room(room_name)
            user = get_current_user()
            if user:
                with state.online_lock:
                    if request.sid in state.online_users:
                        state.online_users[request.sid]["room_id"] = room_id
                emit("user_joined", {
                    "username": user["username"],
                    "display_name": user["display_name"],
                    "color": user["color"],
                }, room=room_name, include_self=False)
                _broadcast_online(room_id)
            print(f"[WS] {request.sid} joined {room_name}")

    @sio.on("leave_room")
    def ws_leave_room(data):
        room_id = data.get("room_id")
        if room_id:
            room_name = f"room_{room_id}"
            leave_room(room_name)
            user = get_current_user()
            if user:
                with state.online_lock:
                    if request.sid in state.online_users:
                        state.online_users[request.sid]["room_id"] = None
                emit("user_left", {
                    "username": user["username"],
                    "display_name": user["display_name"],
                }, room=room_name, include_self=False)
                _broadcast_online(room_id)
            print(f"[WS] {request.sid} left {room_name}")

    @sio.on("join_training")
    def ws_join_training():
        join_room("training")
        print(f"[WS] {request.sid} joined training")

    @sio.on("leave_training")
    def ws_leave_training():
        leave_room("training")

    @sio.on("cursor_move")
    def ws_cursor_move(data):
        sid = request.sid
        with state.online_lock:
            user_info = state.online_users.get(sid)
        if not user_info or not user_info.get("room_id"):
            return
        room_id = user_info["room_id"]
        emit("cursor_update", {
            "user_id": user_info["user_id"],
            "username": user_info["username"],
            "display_name": user_info["display_name"],
            "color": user_info["color"],
            "x": data.get("x", 0),
            "y": data.get("y", 0),
            "image_name": data.get("image_name", ""),
        }, room=f"room_{room_id}", include_self=False)


def _broadcast_online(room_id):
    with state.online_lock:
        online = [
            {"user_id": u["user_id"], "username": u["username"],
             "display_name": u["display_name"], "color": u["color"]}
            for u in state.online_users.values()
            if u.get("room_id") == room_id
        ]
    socketio.emit("online_users", {"room_id": room_id, "users": online}, room=f"room_{room_id}")
