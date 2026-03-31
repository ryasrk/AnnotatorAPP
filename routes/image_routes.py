"""
Image listing and label CRUD routes.
"""

from flask import Blueprint, jsonify, request, session, send_from_directory

from auth import login_required, get_current_user
from database import get_db
from extensions import socketio
from services.image_service import get_annotation_info
from services.label_service import read_labels, write_labels
from config import PER_PAGE_DEFAULT, PER_PAGE_MAX
import state

bp = Blueprint("image_routes", __name__)


@bp.route("/api/images")
def api_images():
    page = int(request.args.get("page", 0))
    per_page = min(PER_PAGE_MAX, int(request.args.get("per_page", PER_PAGE_DEFAULT)))
    filter_type = request.args.get("filter", "all")
    search = request.args.get("search", "").lower()
    sort = request.args.get("sort", "name-asc")
    room_id = request.args.get("room_id", type=int)

    assigned_names = set()
    if filter_type == "assigned" and room_id and "user_id" in session:
        db = get_db()
        rows = db.execute(
            "SELECT image_name FROM image_assignments WHERE room_id = ? AND user_id = ?",
            (room_id, session["user_id"])
        ).fetchall()
        db.close()
        assigned_names = {r["image_name"] for r in rows}

    filtered = []
    for name in state.image_names:
        if search and search not in name.lower():
            continue
        if filter_type == "assigned":
            if name not in assigned_names:
                continue
        elif filter_type != "all":
            info = get_annotation_info(name)
            if filter_type == "annotated" and not info["annotated"]:
                continue
            if filter_type == "unannotated" and info["annotated"]:
                continue
        filtered.append(name)

    if sort == "name-desc":
        filtered.sort(reverse=True)
    elif sort == "annotated-first":
        filtered.sort(key=lambda n: (0 if get_annotation_info(n)["annotated"] else 1, n))
    elif sort == "unannotated-first":
        filtered.sort(key=lambda n: (1 if get_annotation_info(n)["annotated"] else 0, n))
    elif sort == "boxes-desc":
        filtered.sort(key=lambda n: -get_annotation_info(n)["bbox_count"])
    elif sort == "boxes-asc":
        filtered.sort(key=lambda n: get_annotation_info(n)["bbox_count"])

    total = len(filtered)
    start = page * per_page
    page_items = filtered[start:start + per_page]

    result = []
    for i, name in enumerate(page_items):
        info = get_annotation_info(name)
        result.append({
            "name": name,
            "annotated": info["annotated"],
            "bbox_count": info["bbox_count"],
            "global_index": start + i + 1,
        })

    return jsonify({
        "images": result, "total": total, "page": page,
        "per_page": per_page,
        "total_pages": max(1, (total + per_page - 1) // per_page),
    })


@bp.route("/api/image/<path:filename>")
def api_image(filename):
    if "/" in filename or "\\" in filename or ".." in filename:
        return jsonify({"error": "Invalid filename"}), 400
    return send_from_directory(str(state.RAW_IMAGES_DIR), filename)


@bp.route("/api/labels/<path:image_name>")
def api_labels(image_name):
    if "/" in image_name or "\\" in image_name or ".." in image_name:
        return jsonify({"error": "Invalid filename"}), 400
    return jsonify({
        "image": image_name,
        "labels": read_labels(image_name),
        "class_names": state.CLASS_NAMES,
    })


@bp.route("/api/labels/<path:image_name>", methods=["POST"])
@login_required
def api_save_labels(image_name):
    if "/" in image_name or "\\" in image_name or ".." in image_name:
        return jsonify({"error": "Invalid filename"}), 400

    data = request.get_json()
    if data is None:
        return jsonify({"error": "Invalid JSON"}), 400

    labels = data.get("labels", [])
    validated = []
    for lbl in labels:
        try:
            validated.append({
                "class_id": int(lbl["class_id"]),
                "cx": max(0.0, min(1.0, float(lbl["cx"]))),
                "cy": max(0.0, min(1.0, float(lbl["cy"]))),
                "w": max(0.0, min(1.0, float(lbl["w"]))),
                "h": max(0.0, min(1.0, float(lbl["h"]))),
            })
        except (KeyError, ValueError, TypeError):
            return jsonify({"error": "Invalid label format"}), 400

    write_labels(image_name, validated)

    with state.state_lock:
        state.image_cache[image_name] = {
            "annotated": len(validated) > 0,
            "bbox_count": len(validated),
        }

    user_id = session.get("user_id")
    room_id = session.get("room_id") or state.CURRENT_ROOM_ID
    if user_id and room_id:
        db = get_db()
        db.execute(
            "INSERT INTO image_edits (room_id, image_name, user_id) VALUES (?, ?, ?)",
            (room_id, image_name, user_id),
        )
        db.commit()
        db.close()

        user = get_current_user()
        socketio.emit("label_saved", {
            "image_name": image_name,
            "bbox_count": len(validated),
            "annotated": len(validated) > 0,
            "editor": {
                "username": user["username"] if user else "unknown",
                "display_name": user["display_name"] if user else "unknown",
                "color": user["color"] if user else "#888",
            },
        }, room=f"room_{room_id}")

    return jsonify({"status": "saved", "count": len(validated)})
