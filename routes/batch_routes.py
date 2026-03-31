"""
Batch operations: delete labels, reassign class.
"""

from pathlib import Path

from flask import Blueprint, jsonify, request

from auth import login_required
from services.image_service import build_cache
import state

bp = Blueprint("batch_routes", __name__)


@bp.route("/api/batch/delete-labels", methods=["POST"])
@login_required
def api_batch_delete_labels():
    data = request.get_json()
    image_names = data.get("image_names", [])
    if not image_names:
        return jsonify({"error": "No images specified"}), 400
    deleted = 0
    for name in image_names:
        stem = Path(name).stem
        label_path = state.RAW_LABELS_DIR / f"{stem}.txt"
        if label_path.exists():
            label_path.unlink()
            deleted += 1
    build_cache()
    return jsonify({"ok": True, "deleted": deleted})


@bp.route("/api/batch/reassign-class", methods=["POST"])
@login_required
def api_batch_reassign_class():
    data = request.get_json()
    image_names = data.get("image_names", [])
    from_class = data.get("from_class")
    to_class = data.get("to_class")
    if from_class is None or to_class is None:
        return jsonify({"error": "from_class and to_class required"}), 400
    modified = 0
    for name in image_names:
        stem = Path(name).stem
        label_path = state.RAW_LABELS_DIR / f"{stem}.txt"
        if label_path.exists():
            lines = label_path.read_text().strip().split("\n")
            new_lines = []
            changed = False
            for line in lines:
                parts = line.strip().split()
                if parts and parts[0] == str(from_class):
                    parts[0] = str(to_class)
                    changed = True
                new_lines.append(" ".join(parts))
            if changed:
                label_path.write_text("\n".join(new_lines) + "\n")
                modified += 1
    build_cache()
    return jsonify({"ok": True, "modified": modified})
