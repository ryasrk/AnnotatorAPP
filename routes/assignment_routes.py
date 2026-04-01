"""
Image assignment routes.
"""

from flask import Blueprint, jsonify, request

from auth import login_required
from database import get_db_ctx
import state

bp = Blueprint("assignment_routes", __name__)


@bp.route("/api/assignments/<int:room_id>", methods=["GET"])
@login_required
def api_get_assignments(room_id):
    with get_db_ctx() as db:
        rows = db.execute(
            "SELECT a.image_name, a.user_id, u.username, u.display_name, u.color "
            "FROM image_assignments a JOIN users u ON a.user_id = u.id WHERE a.room_id = ?",
            (room_id,)
        ).fetchall()
    return jsonify({"assignments": {r["image_name"]: {"user_id": r["user_id"], "username": r["username"],
        "display_name": r["display_name"], "color": r["color"]} for r in rows}})


@bp.route("/api/assignments/<int:room_id>", methods=["POST"])
@login_required
def api_set_assignments(room_id):
    data = request.get_json()
    image_names = data.get("image_names", [])
    user_id = data.get("user_id")
    if not image_names:
        return jsonify({"error": "No images specified"}), 400
    with get_db_ctx() as db:
        for name in image_names:
            if user_id:
                db.execute(
                    "INSERT OR REPLACE INTO image_assignments (room_id, image_name, user_id) VALUES (?, ?, ?)",
                    (room_id, name, user_id)
                )
            else:
                db.execute("DELETE FROM image_assignments WHERE room_id = ? AND image_name = ?", (room_id, name))
        db.commit()
    return jsonify({"ok": True, "count": len(image_names)})


@bp.route("/api/assignments/<int:room_id>/distribute", methods=["POST"])
@login_required
def api_distribute_assignments(room_id):
    data = request.get_json()
    ratios = data.get("ratios", [])
    if not ratios:
        return jsonify({"error": "No ratios provided"}), 400

    total_pct = sum(r.get("pct", 0) for r in ratios)
    if total_pct == 0:
        return jsonify({"error": "Total percentage is 0"}), 400

    all_images = list(state.image_names)
    if not all_images:
        return jsonify({"error": "No images available"}), 400

    with get_db_ctx() as db:
        db.execute("DELETE FROM image_assignments WHERE room_id = ?", (room_id,))

        idx = 0
        active_ratios = [r for r in ratios if r.get("pct", 0) > 0]
        for r in active_ratios:
            count = round(len(all_images) * r["pct"] / 100)
            user_id = r["user_id"]
            for i in range(count):
                if idx >= len(all_images):
                    break
                db.execute(
                    "INSERT INTO image_assignments (room_id, image_name, user_id) VALUES (?, ?, ?)",
                    (room_id, all_images[idx], user_id)
                )
                idx += 1

        if active_ratios and idx < len(all_images):
            last_uid = active_ratios[-1]["user_id"]
            while idx < len(all_images):
                db.execute(
                    "INSERT INTO image_assignments (room_id, image_name, user_id) VALUES (?, ?, ?)",
                    (room_id, all_images[idx], last_uid)
                )
                idx += 1

        db.commit()
    return jsonify({"ok": True, "total": len(all_images), "assigned": idx})
