"""
Model inference routes: predict, list models.
"""

from pathlib import Path

from flask import Blueprint, jsonify, request

from auth import login_required
from config import BASE_DIR, MODELS_DIR
import state

bp = Blueprint("inference_routes", __name__)


@bp.route("/api/inference/predict", methods=["POST"])
@login_required
def api_inference_predict():
    data = request.get_json()
    model_path = data.get("model_path", "")
    image_name = data.get("image_name", "")
    confidence = data.get("confidence", 0.25)

    if not model_path or not image_name:
        return jsonify({"error": "model_path and image_name required"}), 400

    model_file = Path(model_path)
    if not model_file.exists():
        return jsonify({"error": "Model file not found"}), 404

    image_path = state.RAW_IMAGES_DIR / image_name
    if not image_path.exists():
        return jsonify({"error": "Image not found"}), 404

    try:
        from ultralytics import YOLO
        model = YOLO(str(model_file))
        results = model.predict(str(image_path), conf=confidence, verbose=False)
        model_names = model.names if hasattr(model, 'names') else {}
        detections = []
        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                img_w, img_h = r.orig_shape[1], r.orig_shape[0]
                cx = (x1 + x2) / 2 / img_w
                cy = (y1 + y2) / 2 / img_h
                bw = (x2 - x1) / img_w
                bh = (y2 - y1) / img_h
                cls_id = int(box.cls[0])
                detections.append({
                    "class_id": cls_id,
                    "class_name": model_names.get(cls_id, f"class_{cls_id}"),
                    "confidence": round(float(box.conf[0]), 3),
                    "cx": round(cx, 6), "cy": round(cy, 6),
                    "w": round(bw, 6), "h": round(bh, 6),
                })
        return jsonify({"ok": True, "detections": detections, "count": len(detections),
                        "model_names": {str(k): v for k, v in model_names.items()}})
    except ImportError:
        return jsonify({"error": "ultralytics not installed"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/inference/models")
@login_required
def api_inference_models():
    models = []
    search_dirs = [
        MODELS_DIR,
        BASE_DIR / "runs",
        state.EXPORT_DIR,
        Path(__file__).resolve().parent.parent,
    ]
    for search_dir in search_dirs:
        if search_dir.exists():
            for pt_file in search_dir.rglob("*.pt"):
                models.append({
                    "name": pt_file.name,
                    "path": str(pt_file),
                    "size_mb": round(pt_file.stat().st_size / (1024 * 1024), 1),
                })
    seen = set()
    unique = []
    for m in models:
        if m["path"] not in seen:
            seen.add(m["path"])
            unique.append(m)
    return jsonify({"models": unique})
