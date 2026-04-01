"""
Folder management routes: open, save, browse, current dirs.
"""

import platform
from pathlib import Path

from flask import Blueprint, jsonify, request, session

from auth import login_required
from config import ALLOWED_ROOTS
from database import get_db_ctx
from extensions import socketio
from services.image_service import reload_dataset
import state

bp = Blueprint("folder_routes", __name__)


def _is_path_allowed(path_str):
    """Check if a resolved path is under one of the allowed roots."""
    resolved = str(Path(path_str).resolve())
    return any(resolved.startswith(str(Path(root).resolve())) for root in ALLOWED_ROOTS)


@bp.route("/api/open-folder", methods=["POST"])
@login_required
def api_open_folder():
    data = request.get_json() or {}
    mode = data.get("mode", "images_labels")
    folder = data.get("folder", "").strip()
    images_dir = data.get("images_dir", "").strip()
    labels_dir = data.get("labels_dir", "").strip()

    if mode == "images_only":
        if not folder:
            return jsonify({"error": "folder is required"}), 400
        img_path = Path(folder).resolve()
        if not _is_path_allowed(img_path):
            return jsonify({"error": "Access denied: path outside allowed roots"}), 403
        if not img_path.is_dir():
            return jsonify({"error": f"Not a directory: {folder}"}), 400
        lbl_path = img_path.parent / "labels"
        lbl_path.mkdir(parents=True, exist_ok=True)

    elif mode == "mixed":
        if not folder:
            return jsonify({"error": "folder is required"}), 400
        img_path = Path(folder).resolve()
        if not _is_path_allowed(img_path):
            return jsonify({"error": "Access denied: path outside allowed roots"}), 403
        if not img_path.is_dir():
            return jsonify({"error": f"Not a directory: {folder}"}), 400
        lbl_path = img_path

    else:  # images_labels
        if not images_dir:
            return jsonify({"error": "images_dir is required"}), 400
        img_path = Path(images_dir).resolve()
        if not _is_path_allowed(img_path):
            return jsonify({"error": "Access denied: path outside allowed roots"}), 403
        if not img_path.is_dir():
            return jsonify({"error": f"Not a directory: {images_dir}"}), 400
        lbl_path = Path(labels_dir).resolve() if labels_dir else img_path.parent / "labels"
        if not lbl_path.is_dir():
            lbl_path.mkdir(parents=True, exist_ok=True)

    state.RAW_IMAGES_DIR = img_path
    state.RAW_LABELS_DIR = lbl_path

    room_id = session.get("room_id") or state.CURRENT_ROOM_ID
    if room_id:
        with get_db_ctx() as db:
            db.execute(
                "UPDATE rooms SET images_dir=?, labels_dir=?, folder_mode=? WHERE id=?",
                (str(img_path), str(lbl_path), mode, room_id),
            )
            db.commit()

    reload_dataset()

    if room_id:
        socketio.emit("folder_changed", {
            "images_dir": str(state.RAW_IMAGES_DIR),
            "labels_dir": str(state.RAW_LABELS_DIR),
            "image_count": len(state.image_names),
        }, room=f"room_{room_id}")

    return jsonify({
        "status": "ok", "mode": mode,
        "images_dir": str(state.RAW_IMAGES_DIR),
        "labels_dir": str(state.RAW_LABELS_DIR),
        "image_count": len(state.image_names),
    })


@bp.route("/api/save-folder", methods=["POST"])
@login_required
def api_save_folder():
    data = request.get_json() or {}
    save_dir = data.get("save_dir", "").strip()
    if not save_dir:
        return jsonify({"error": "save_dir is required"}), 400
    path = Path(save_dir).resolve()
    if not _is_path_allowed(path):
        return jsonify({"error": "Access denied: path outside allowed roots"}), 403
    path.mkdir(parents=True, exist_ok=True)
    state.EXPORT_DIR = path

    room_id = session.get("room_id") or state.CURRENT_ROOM_ID
    if room_id:
        with get_db_ctx() as db:
            db.execute("UPDATE rooms SET export_dir=? WHERE id=?", (str(path), room_id))
            db.commit()

    return jsonify({"status": "ok", "save_dir": str(state.EXPORT_DIR)})


@bp.route("/api/current-dirs")
def api_current_dirs():
    return jsonify({
        "images_dir": str(state.RAW_IMAGES_DIR),
        "labels_dir": str(state.RAW_LABELS_DIR),
        "export_dir": str(state.EXPORT_DIR),
        "room_id": state.CURRENT_ROOM_ID,
    })


@bp.route("/api/browse", methods=["POST"])
@login_required
def api_browse():
    data = request.get_json() or {}
    browse_path = data.get("path", "").strip()

    if not browse_path:
        # Return allowed roots instead of filesystem root
        return jsonify({"path": "", "dirs": ALLOWED_ROOTS, "is_root": True})

    p = Path(browse_path).resolve()
    if not _is_path_allowed(p):
        return jsonify({"error": "Access denied: path outside allowed roots"}), 403
    if not p.is_dir():
        return jsonify({"error": "Not a directory"}), 400

    dirs = []
    files = []
    file_ext = data.get("file_ext", None)  # e.g. ".pt" or ".yaml,.yml"
    ext_set = set()
    if file_ext:
        ext_set = {e.strip().lower() for e in file_ext.split(",") if e.strip()}
    try:
        for item in sorted(p.iterdir()):
            if item.is_dir() and not item.name.startswith("."):
                dirs.append(item.name)
            elif ext_set and item.is_file() and item.suffix.lower() in ext_set:
                files.append({"name": item.name, "path": str(item), "size_mb": round(item.stat().st_size / (1024 * 1024), 1)})
    except PermissionError:
        return jsonify({"error": "Permission denied"}), 403

    return jsonify({
        "path": str(p),
        "parent": str(p.parent) if p != p.parent else None,
        "dirs": dirs[:200],
        "files": files[:200] if ext_set else [],
        "is_root": p == p.parent,
    })
