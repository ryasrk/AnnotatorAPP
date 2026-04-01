"""
Model inference routes: predict, list models, apply predictions.
"""

import threading
from pathlib import Path

from flask import Blueprint, jsonify, request, session

from auth import login_required
from config import BASE_DIR, MODELS_DIR
from extensions import socketio
from rate_limit import heavy_rate_limit
from services.label_service import write_labels, read_labels
import state

bp = Blueprint("inference_routes", __name__)


@bp.route("/api/inference/predict", methods=["POST"])
@login_required
@heavy_rate_limit
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
        is_seg = hasattr(results[0], 'masks') and results[0].masks is not None
        detections = []
        for r in results:
            img_w, img_h = r.orig_shape[1], r.orig_shape[0]
            # Segmentation masks → polygon annotations
            if is_seg and r.masks is not None:
                for i, mask in enumerate(r.masks.xyn):
                    points = mask.tolist()
                    if len(points) < 3:
                        continue
                    cls_id = int(r.boxes[i].cls[0])
                    detections.append({
                        "type": "polygon",
                        "class_id": cls_id,
                        "class_name": model_names.get(cls_id, f"class_{cls_id}"),
                        "confidence": round(float(r.boxes[i].conf[0]), 3),
                        "points": [[round(p[0], 6), round(p[1], 6)] for p in points],
                    })
            # Bounding boxes
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                cx = (x1 + x2) / 2 / img_w
                cy = (y1 + y2) / 2 / img_h
                bw = (x2 - x1) / img_w
                bh = (y2 - y1) / img_h
                cls_id = int(box.cls[0])
                det = {
                    "type": "bbox",
                    "class_id": cls_id,
                    "class_name": model_names.get(cls_id, f"class_{cls_id}"),
                    "confidence": round(float(box.conf[0]), 3),
                    "cx": round(cx, 6), "cy": round(cy, 6),
                    "w": round(bw, 6), "h": round(bh, 6),
                }
                # Only add bbox if not a seg model (seg already has polygons)
                if not is_seg:
                    detections.append(det)
        return jsonify({"ok": True, "detections": detections, "count": len(detections),
                        "model_names": {str(k): v for k, v in model_names.items()},
                        "is_seg": is_seg})
    except ImportError:
        return jsonify({"error": "ultralytics not installed"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/inference/model-classes", methods=["POST"])
@login_required
def api_model_classes():
    """Probe a model to get its class names."""
    data = request.get_json() or {}
    model_path = data.get("model_path", "")
    if not model_path:
        return jsonify({"error": "model_path required"}), 400

    model_file = Path(model_path)
    if not model_file.exists():
        return jsonify({"error": "Model file not found"}), 404

    try:
        from ultralytics import YOLO
        model = YOLO(str(model_file))
        names = model.names if hasattr(model, 'names') else {}
        classes = [{"id": k, "name": v} for k, v in sorted(names.items())]
        return jsonify({"ok": True, "classes": classes, "model": model_file.name})
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


# =============================================================================
# Apply Predictions — Active Learning Loop
# =============================================================================

# Track apply-predictions progress per room
_apply_progress = {}
_apply_lock = threading.Lock()


@bp.route("/api/inference/apply-predictions", methods=["POST"])
@login_required
@heavy_rate_limit
def api_apply_predictions():
    """Run inference on selected (or all unannotated) images and save detections as labels.

    Active learning loop: Train → Predict → Pre-annotate → Human Review → Re-train.
    """
    data = request.get_json() or {}
    model_path = data.get("model_path", "")
    confidence = max(0.01, min(1.0, float(data.get("confidence", 0.25))))
    image_names = data.get("image_names", [])
    mode = data.get("mode", "unannotated")  # "unannotated", "all", "selected", "annotated", "assigned"
    overwrite = data.get("overwrite", False)
    class_mapping = data.get("class_mapping", None)  # optional: {model_class_id: room_class_id}
    selected_classes = data.get("selected_classes", None)  # optional: list of model class IDs to include

    if not model_path:
        return jsonify({"error": "model_path required"}), 400

    model_file = Path(model_path)
    if not model_file.exists():
        return jsonify({"error": "Model file not found"}), 404

    room_id = session.get("room_id") or state.CURRENT_ROOM_ID

    # Determine target images
    if mode == "selected" and image_names:
        targets = [n for n in image_names if (state.RAW_IMAGES_DIR / n).exists()]
    elif mode == "unannotated":
        with state.state_lock:
            targets = [n for n in state.image_names
                       if n not in state.image_cache or not state.image_cache[n]["annotated"]]
    elif mode == "annotated":
        with state.state_lock:
            targets = [n for n in state.image_names
                       if n in state.image_cache and state.image_cache[n]["annotated"]]
    elif mode == "assigned":
        user_id = session.get("user_id")
        if not user_id or not room_id:
            return jsonify({"error": "Must be in a room to use assigned filter"}), 400
        from database import get_db
        db = get_db()
        rows = db.execute(
            "SELECT image_name FROM image_assignments WHERE room_id = ? AND user_id = ?",
            (room_id, user_id)
        ).fetchall()
        db.close()
        assigned_names = {r["image_name"] for r in rows}
        targets = [n for n in state.image_names if n in assigned_names]
    else:  # all
        targets = list(state.image_names)

    if not targets:
        return jsonify({"error": "No target images found"}), 400

    # Start background processing
    job_id = f"apply_{room_id or 'global'}"
    with _apply_lock:
        if job_id in _apply_progress and _apply_progress[job_id].get("status") == "running":
            return jsonify({"error": "Apply predictions already in progress"}), 409
        _apply_progress[job_id] = {"status": "running", "total": len(targets), "done": 0, "saved": 0}

    def _run_apply():
        try:
            from ultralytics import YOLO
            model = YOLO(str(model_file))
            model_names = model.names if hasattr(model, 'names') else {}
            selected_classes_set = set(int(c) for c in selected_classes) if selected_classes is not None else None
            iou_thresh = max(0.01, min(1.0, float(data.get("iou", 0.7))))
            imgsz_val = int(data.get("imgsz", 640))
            max_det_val = int(data.get("max_det", 300))
            saved_count = 0

            for idx, img_name in enumerate(targets):
                img_path = state.RAW_IMAGES_DIR / img_name

                # Skip if already annotated and not overwriting
                if not overwrite:
                    existing = read_labels(img_name)
                    if existing:
                        with _apply_lock:
                            _apply_progress[job_id]["done"] = idx + 1
                        continue

                try:
                    results = model.predict(str(img_path), conf=confidence, iou=iou_thresh,
                                            imgsz=imgsz_val, max_det=max_det_val, verbose=False)
                    labels = []
                    for r in results:
                        img_w, img_h = r.orig_shape[1], r.orig_shape[0]
                        is_seg = hasattr(r, 'masks') and r.masks is not None

                        # Segmentation model → polygon labels
                        if is_seg and r.masks is not None:
                            for i, mask in enumerate(r.masks.xyn):
                                points = mask.tolist()
                                if len(points) < 3:
                                    continue
                                cls_id = int(r.boxes[i].cls[0])
                                if selected_classes_set is not None and cls_id not in selected_classes_set:
                                    continue
                                if class_mapping and str(cls_id) in class_mapping:
                                    cls_id = int(class_mapping[str(cls_id)])
                                labels.append({
                                    "type": "polygon",
                                    "class_id": cls_id,
                                    "points": [[max(0.0, min(1.0, p[0])), max(0.0, min(1.0, p[1]))] for p in points],
                                })
                        else:
                            # Detection model → bbox labels
                            for box in r.boxes:
                                x1, y1, x2, y2 = box.xyxy[0].tolist()
                                cx = round((x1 + x2) / 2 / img_w, 6)
                                cy = round((y1 + y2) / 2 / img_h, 6)
                                bw = round((x2 - x1) / img_w, 6)
                                bh = round((y2 - y1) / img_h, 6)
                                cls_id = int(box.cls[0])

                                # Filter by selected classes if specified
                                if selected_classes_set is not None and cls_id not in selected_classes_set:
                                    continue

                                # Apply class mapping if provided
                                if class_mapping and str(cls_id) in class_mapping:
                                    cls_id = int(class_mapping[str(cls_id)])

                                labels.append({
                                    "class_id": cls_id,
                                    "cx": max(0.0, min(1.0, cx)),
                                    "cy": max(0.0, min(1.0, cy)),
                                    "w": max(0.0, min(1.0, bw)),
                                    "h": max(0.0, min(1.0, bh)),
                                })

                    if labels:
                        write_labels(img_name, labels)
                        with state.state_lock:
                            state.image_cache[img_name] = {
                                "annotated": True,
                                "bbox_count": len(labels),
                            }
                        saved_count += 1

                except Exception:
                    pass  # Skip individual failures

                with _apply_lock:
                    _apply_progress[job_id]["done"] = idx + 1
                    _apply_progress[job_id]["saved"] = saved_count

                # Emit progress every 10 images
                if (idx + 1) % 10 == 0 or idx == len(targets) - 1:
                    socketio.emit("apply_progress", {
                        "done": idx + 1,
                        "total": len(targets),
                        "saved": saved_count,
                    }, room=f"room_{room_id}" if room_id else "training")

            with _apply_lock:
                _apply_progress[job_id]["status"] = "completed"
                _apply_progress[job_id]["saved"] = saved_count

            socketio.emit("apply_complete", {
                "total": len(targets),
                "saved": saved_count,
                "model": model_file.name,
            }, room=f"room_{room_id}" if room_id else "training")

        except Exception as e:
            with _apply_lock:
                _apply_progress[job_id]["status"] = "error"
                _apply_progress[job_id]["error"] = str(e)
            socketio.emit("apply_error", {"error": str(e)},
                          room=f"room_{room_id}" if room_id else "training")

    threading.Thread(target=_run_apply, daemon=True).start()

    return jsonify({
        "status": "started",
        "target_count": len(targets),
        "model": model_file.name,
        "confidence": confidence,
        "mode": mode,
        "overwrite": overwrite,
    })


@bp.route("/api/inference/apply-progress")
@login_required
def api_apply_progress():
    """Check progress of apply-predictions job."""
    room_id = request.args.get("room_id") or session.get("room_id") or state.CURRENT_ROOM_ID
    job_id = f"apply_{room_id or 'global'}"
    with _apply_lock:
        progress = _apply_progress.get(job_id, {"status": "idle"})
    return jsonify(progress)
