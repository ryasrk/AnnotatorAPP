"""
Export routes: YOLO, COCO, VOC dataset export.
"""

import random
from pathlib import Path

from flask import Blueprint, jsonify, request

from auth import login_required
from rate_limit import heavy_rate_limit
from services.export_service import export_yolo, export_coco, export_voc
import state

bp = Blueprint("export_routes", __name__)


@bp.route("/api/export", methods=["POST"])
@login_required
@heavy_rate_limit
def api_export():
    data = request.get_json() or {}
    train_ratio = max(0.1, min(0.95, float(data.get("train_ratio", 0.8))))
    seed = int(data.get("seed", 42))
    export_format = data.get("format", "yolo")
    export_path = data.get("export_path", "").strip()

    target_dir = Path(export_path) if export_path else state.EXPORT_DIR

    with state.state_lock:
        annotated_images = [n for n, v in state.image_cache.items() if v["annotated"]]

    if not annotated_images:
        return jsonify({"error": "No annotated images to export"}), 400

    random.seed(seed)
    random.shuffle(annotated_images)

    split_idx = int(len(annotated_images) * train_ratio)
    train_imgs = annotated_images[:split_idx]
    valid_imgs = annotated_images[split_idx:]

    if export_format == "yolo":
        return jsonify(export_yolo(target_dir, train_imgs, valid_imgs))
    elif export_format == "coco":
        return jsonify(export_coco(target_dir, train_imgs, valid_imgs))
    elif export_format == "voc":
        return jsonify(export_voc(target_dir, train_imgs, valid_imgs))
    else:
        return jsonify({"error": "Unsupported format: " + export_format}), 400
