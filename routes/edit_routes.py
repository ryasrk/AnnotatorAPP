"""
Edit tracking routes.
"""

from flask import Blueprint, jsonify, request, session

from database import get_db
import state

bp = Blueprint("edit_routes", __name__)


@bp.route("/api/image-edits")
def api_image_edits():
    room_id = request.args.get("room_id") or session.get("room_id") or state.CURRENT_ROOM_ID
    if not room_id:
        return jsonify({"edits": {}})

    db = get_db()
    edits = db.execute("""
        SELECT ie.image_name, ie.edited_at, u.username, u.display_name, u.color
        FROM image_edits ie
        JOIN users u ON ie.user_id = u.id
        WHERE ie.id IN (
            SELECT MAX(id) FROM image_edits WHERE room_id = ? GROUP BY image_name
        )
    """, (room_id,)).fetchall()
    db.close()

    return jsonify({
        "edits": {
            e["image_name"]: {
                "username": e["username"],
                "display_name": e["display_name"],
                "color": e["color"],
                "edited_at": e["edited_at"],
            }
            for e in edits
        }
    })
