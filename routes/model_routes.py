"""
Model management routes: validate, export, benchmark.
"""

import json
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request, session

from auth import login_required
from config import BASE_DIR
from extensions import socketio
from rate_limit import heavy_rate_limit
import state

bp = Blueprint("model_routes", __name__)

# In-memory job tracker for async tasks
_model_jobs = {}
_model_jobs_lock = threading.Lock()


# =============================================================================
# Validation — run model.val() and return mAP, precision, recall, plots
# =============================================================================

@bp.route("/api/model/validate", methods=["POST"])
@login_required
@heavy_rate_limit
def api_model_validate():
    """Run YOLO model validation and return metrics + plot paths."""
    data = request.get_json() or {}
    model_path = data.get("model_path", "").strip()
    data_yaml = data.get("data_yaml", "").strip()
    imgsz = int(data.get("imgsz", 640))
    conf = float(data.get("conf", 0.001))
    iou = float(data.get("iou", 0.6))
    split = data.get("split", "val")  # val or test

    if not model_path:
        return jsonify({"error": "model_path required"}), 400

    model_file = Path(model_path)
    if not model_file.exists():
        return jsonify({"error": "Model file not found"}), 404

    if data_yaml:
        yaml_path = Path(data_yaml)
        if not yaml_path.exists():
            return jsonify({"error": "data.yaml not found"}), 404
    else:
        yaml_path = state.EXPORT_DIR / "data.yaml"
        if not yaml_path.exists():
            return jsonify({"error": "No data.yaml found. Export dataset first or specify path."}), 400

    job_id = f"val_{uuid.uuid4().hex[:8]}"
    with _model_jobs_lock:
        _model_jobs[job_id] = {"status": "running", "type": "validate", "started": datetime.now().isoformat()}

    room_id = session.get("room_id") or state.CURRENT_ROOM_ID

    def _run_val():
        try:
            from ultralytics import YOLO
            model = YOLO(str(model_file))
            results = model.val(
                data=str(yaml_path),
                imgsz=imgsz,
                conf=conf,
                iou=iou,
                split=split,
                verbose=False,
                plots=True,
            )

            # Collect metrics
            metrics = {}
            if hasattr(results, 'box'):
                box = results.box
                metrics["mAP50"] = round(float(box.map50), 4) if hasattr(box, 'map50') else None
                metrics["mAP50_95"] = round(float(box.map), 4) if hasattr(box, 'map') else None

                # Per-class metrics
                if hasattr(box, 'ap_class_index') and hasattr(box, 'p') and hasattr(box, 'r'):
                    per_class = []
                    names = model.names if hasattr(model, 'names') else {}
                    for i, cls_idx in enumerate(box.ap_class_index):
                        cls_idx = int(cls_idx)
                        per_class.append({
                            "class_id": cls_idx,
                            "class_name": names.get(cls_idx, f"class_{cls_idx}"),
                            "precision": round(float(box.p[i]), 4),
                            "recall": round(float(box.r[i]), 4),
                            "ap50": round(float(box.ap50[i]), 4) if hasattr(box, 'ap50') else None,
                            "ap": round(float(box.ap[i]), 4) if hasattr(box, 'ap') else None,
                        })
                    metrics["per_class"] = per_class

            # Overall precision/recall
            if hasattr(results, 'results_dict'):
                rd = results.results_dict
                metrics["precision"] = round(float(rd.get("metrics/precision(B)", 0)), 4)
                metrics["recall"] = round(float(rd.get("metrics/recall(B)", 0)), 4)
                metrics["fitness"] = round(float(rd.get("fitness", 0)), 4)

            # Find plot images
            save_dir = Path(results.save_dir) if hasattr(results, 'save_dir') else None
            plots = {}
            if save_dir and save_dir.exists():
                plot_names = [
                    "confusion_matrix.png",
                    "confusion_matrix_normalized.png",
                    "F1_curve.png",
                    "P_curve.png",
                    "R_curve.png",
                    "PR_curve.png",
                    "val_batch0_labels.jpg",
                    "val_batch0_pred.jpg",
                    "val_batch1_labels.jpg",
                    "val_batch1_pred.jpg",
                    "val_batch2_labels.jpg",
                    "val_batch2_pred.jpg",
                ]
                for pn in plot_names:
                    plot_path = save_dir / pn
                    if plot_path.exists():
                        plots[pn.replace(".png", "").replace(".jpg", "")] = str(plot_path)

            metrics["plots"] = plots
            metrics["save_dir"] = str(save_dir) if save_dir else None
            metrics["model"] = model_file.name
            metrics["data_yaml"] = str(yaml_path)

            with _model_jobs_lock:
                _model_jobs[job_id] = {"status": "completed", "type": "validate", "result": metrics}

            socketio.emit("model_job_complete", {
                "job_id": job_id, "type": "validate", "result": metrics,
            }, room=f"room_{room_id}" if room_id else "training")

        except Exception as e:
            with _model_jobs_lock:
                _model_jobs[job_id] = {"status": "error", "type": "validate", "error": str(e)}
            socketio.emit("model_job_error", {
                "job_id": job_id, "type": "validate", "error": str(e),
            }, room=f"room_{room_id}" if room_id else "training")

    threading.Thread(target=_run_val, daemon=True).start()

    return jsonify({"status": "started", "job_id": job_id, "type": "validate"})


# =============================================================================
# Model Export — convert .pt to ONNX, TensorRT, CoreML, TFLite, etc.
# =============================================================================

EXPORT_FORMATS = {
    "onnx": {"label": "ONNX", "ext": ".onnx", "desc": "Open Neural Network Exchange"},
    "torchscript": {"label": "TorchScript", "ext": ".torchscript", "desc": "PyTorch TorchScript"},
    "openvino": {"label": "OpenVINO", "ext": "_openvino_model/", "desc": "Intel OpenVINO IR"},
    "engine": {"label": "TensorRT", "ext": ".engine", "desc": "NVIDIA TensorRT (requires GPU)"},
    "coreml": {"label": "CoreML", "ext": ".mlpackage", "desc": "Apple CoreML"},
    "saved_model": {"label": "TF SavedModel", "ext": "_saved_model/", "desc": "TensorFlow SavedModel"},
    "tflite": {"label": "TFLite", "ext": ".tflite", "desc": "TensorFlow Lite"},
    "pb": {"label": "TF GraphDef", "ext": ".pb", "desc": "TensorFlow GraphDef"},
    "edgetpu": {"label": "Edge TPU", "ext": "_edgetpu.tflite", "desc": "Google Edge TPU"},
    "tfjs": {"label": "TF.js", "ext": "_web_model/", "desc": "TensorFlow.js for browser/Node.js"},
    "paddle": {"label": "PaddlePaddle", "ext": "_paddle_model/", "desc": "Baidu PaddlePaddle"},
    "mnn": {"label": "MNN", "ext": ".mnn", "desc": "Alibaba MNN mobile framework"},
    "ncnn": {"label": "NCNN", "ext": "_ncnn_model/", "desc": "Tencent NCNN"},
    "imx": {"label": "IMX500", "ext": "_imx_model/", "desc": "Sony IMX500 sensor"},
    "rknn": {"label": "RKNN", "ext": "_rknn_model/", "desc": "Rockchip RKNN NPU"},
    "executorch": {"label": "ExecuTorch", "ext": "_executorch_model/", "desc": "Meta ExecuTorch mobile"},
    "axelera": {"label": "Axelera", "ext": "_axelera_model/", "desc": "Axelera AI accelerator"},
}


@bp.route("/api/model/export-formats")
@login_required
def api_export_formats():
    """Return available export formats."""
    return jsonify({"formats": EXPORT_FORMATS})


@bp.route("/api/model/export", methods=["POST"])
@login_required
@heavy_rate_limit
def api_model_export():
    """Export a YOLO .pt model to another format."""
    data = request.get_json() or {}
    model_path = data.get("model_path", "").strip()
    export_format = data.get("format", "onnx").strip()
    imgsz = int(data.get("imgsz", 640))
    half = bool(data.get("half", False))
    dynamic = bool(data.get("dynamic", False))
    simplify = bool(data.get("simplify", True))
    batch = int(data.get("batch", 1))

    if not model_path:
        return jsonify({"error": "model_path required"}), 400
    if export_format not in EXPORT_FORMATS:
        return jsonify({"error": f"Unsupported format: {export_format}"}), 400

    model_file = Path(model_path)
    if not model_file.exists():
        return jsonify({"error": "Model file not found"}), 404

    job_id = f"export_{uuid.uuid4().hex[:8]}"
    with _model_jobs_lock:
        _model_jobs[job_id] = {"status": "running", "type": "export", "started": datetime.now().isoformat()}

    room_id = session.get("room_id") or state.CURRENT_ROOM_ID

    def _run_export():
        try:
            from ultralytics import YOLO
            model = YOLO(str(model_file))

            export_kwargs = {
                "format": export_format,
                "imgsz": imgsz,
            }
            # Only add optional params if they differ from defaults
            if half:
                export_kwargs["half"] = True
            if dynamic and export_format == "onnx":
                export_kwargs["dynamic"] = True
            if not simplify and export_format == "onnx":
                export_kwargs["simplify"] = False
            if batch > 1:
                export_kwargs["batch"] = batch

            start_time = time.time()
            exported_path = model.export(**export_kwargs)
            elapsed = round(time.time() - start_time, 1)

            result = {
                "model": model_file.name,
                "format": export_format,
                "format_label": EXPORT_FORMATS[export_format]["label"],
                "exported_path": str(exported_path),
                "elapsed_seconds": elapsed,
            }

            # Get file size if it's a file
            ep = Path(str(exported_path))
            if ep.is_file():
                result["size_mb"] = round(ep.stat().st_size / (1024 * 1024), 2)
            elif ep.is_dir():
                total = sum(f.stat().st_size for f in ep.rglob("*") if f.is_file())
                result["size_mb"] = round(total / (1024 * 1024), 2)

            with _model_jobs_lock:
                _model_jobs[job_id] = {"status": "completed", "type": "export", "result": result}

            socketio.emit("model_job_complete", {
                "job_id": job_id, "type": "export", "result": result,
            }, room=f"room_{room_id}" if room_id else "training")

        except Exception as e:
            with _model_jobs_lock:
                _model_jobs[job_id] = {"status": "error", "type": "export", "error": str(e)}
            socketio.emit("model_job_error", {
                "job_id": job_id, "type": "export", "error": str(e),
            }, room=f"room_{room_id}" if room_id else "training")

    threading.Thread(target=_run_export, daemon=True).start()

    return jsonify({"status": "started", "job_id": job_id, "type": "export",
                     "format": export_format, "model": model_file.name})


# =============================================================================
# Benchmark — compare model formats (speed, size, mAP)
# =============================================================================

@bp.route("/api/model/benchmark", methods=["POST"])
@login_required
@heavy_rate_limit
def api_model_benchmark():
    """Benchmark a YOLO model across different export formats."""
    data = request.get_json() or {}
    model_path = data.get("model_path", "").strip()
    data_yaml = data.get("data_yaml", "").strip()
    imgsz = int(data.get("imgsz", 640))
    half = bool(data.get("half", False))
    device = data.get("device", "cpu").strip()

    if not model_path:
        return jsonify({"error": "model_path required"}), 400

    model_file = Path(model_path)
    if not model_file.exists():
        return jsonify({"error": "Model file not found"}), 404

    job_id = f"bench_{uuid.uuid4().hex[:8]}"
    with _model_jobs_lock:
        _model_jobs[job_id] = {"status": "running", "type": "benchmark", "started": datetime.now().isoformat()}

    room_id = session.get("room_id") or state.CURRENT_ROOM_ID

    def _run_benchmark():
        try:
            from ultralytics.utils.benchmarks import benchmark
            results = benchmark(
                model=str(model_file),
                data=data_yaml if data_yaml else None,
                imgsz=imgsz,
                half=half,
                device=device,
                verbose=False,
            )

            # Parse results DataFrame
            bench_data = []
            if hasattr(results, 'to_dict'):
                df_dict = results.to_dict('records')
                for row in df_dict:
                    bench_data.append({k: (round(v, 4) if isinstance(v, float) else v) for k, v in row.items()})
            else:
                bench_data = [{"info": str(results)}]

            result = {
                "model": model_file.name,
                "device": device,
                "imgsz": imgsz,
                "benchmarks": bench_data,
            }

            with _model_jobs_lock:
                _model_jobs[job_id] = {"status": "completed", "type": "benchmark", "result": result}

            socketio.emit("model_job_complete", {
                "job_id": job_id, "type": "benchmark", "result": result,
            }, room=f"room_{room_id}" if room_id else "training")

        except Exception as e:
            with _model_jobs_lock:
                _model_jobs[job_id] = {"status": "error", "type": "benchmark", "error": str(e)}
            socketio.emit("model_job_error", {
                "job_id": job_id, "type": "benchmark", "error": str(e),
            }, room=f"room_{room_id}" if room_id else "training")

    threading.Thread(target=_run_benchmark, daemon=True).start()

    return jsonify({"status": "started", "job_id": job_id, "type": "benchmark"})


# =============================================================================
# Job Status — poll for async job results
# =============================================================================

@bp.route("/api/model/job/<job_id>")
@login_required
def api_model_job_status(job_id):
    """Check status of an async model job (validate/export/benchmark)."""
    with _model_jobs_lock:
        job = _model_jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


# =============================================================================
# Serve validation plot images
# =============================================================================

@bp.route("/api/model/plot")
@login_required
def api_model_plot():
    """Serve a validation plot image by path."""
    plot_path = request.args.get("path", "").strip()
    if not plot_path:
        return jsonify({"error": "path required"}), 400

    from flask import send_file
    p = Path(plot_path)
    if not p.exists() or not p.is_file():
        return jsonify({"error": "Plot file not found"}), 404

    # Security: only allow image files
    if p.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.gif', '.webp'):
        return jsonify({"error": "Not an image file"}), 400

    # Only serve files from within allowed directories
    allowed = [str(state.EXPORT_DIR), str(BASE_DIR / "runs")]
    if not any(str(p.resolve()).startswith(a) for a in allowed):
        return jsonify({"error": "Access denied"}), 403

    return send_file(str(p), mimetype=f"image/{p.suffix.lstrip('.')}")


# =============================================================================
# Dataset Split — train/val/test split with configurable ratios
# =============================================================================

@bp.route("/api/dataset/split", methods=["POST"])
@login_required
@heavy_rate_limit
def api_dataset_split():
    """Split annotated images into train/val/test sets and export."""
    import random
    import shutil
    from services.label_service import read_labels

    data = request.get_json() or {}
    train_pct = max(10, min(90, int(data.get("train", 70))))
    val_pct = max(5, min(40, int(data.get("val", 20))))
    test_pct = max(0, 100 - train_pct - val_pct)
    seed = int(data.get("seed", 42))
    export_path = data.get("export_path", "").strip()

    target_dir = Path(export_path) if export_path else state.EXPORT_DIR

    with state.state_lock:
        annotated = [n for n, v in state.image_cache.items() if v["annotated"]]

    if not annotated:
        return jsonify({"error": "No annotated images to split"}), 400

    random.seed(seed)
    random.shuffle(annotated)

    total = len(annotated)
    train_n = int(total * train_pct / 100)
    val_n = int(total * val_pct / 100)

    train_imgs = annotated[:train_n]
    val_imgs = annotated[train_n:train_n + val_n]
    test_imgs = annotated[train_n + val_n:]

    splits = {"train": train_imgs, "valid": val_imgs}
    if test_imgs:
        splits["test"] = test_imgs

    for split_name, img_list in splits.items():
        img_dir = target_dir / split_name / "images"
        lbl_dir = target_dir / split_name / "labels"
        for d in [img_dir, lbl_dir]:
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True, exist_ok=True)

        for img_name in img_list:
            src_img = state.RAW_IMAGES_DIR / img_name
            src_lbl = state.RAW_LABELS_DIR / f"{Path(img_name).stem}.txt"
            if src_img.exists():
                shutil.copy2(str(src_img), str(img_dir / img_name))
            if src_lbl.exists():
                shutil.copy2(str(src_lbl), str(lbl_dir / (Path(img_name).stem + ".txt")))

    # Write data.yaml
    data_yaml = target_dir / "data.yaml"
    with open(data_yaml, "w") as f:
        f.write(f"train: ../train/images\n")
        f.write(f"val: ../valid/images\n")
        if test_imgs:
            f.write(f"test: ../test/images\n")
        f.write(f"\nnc: {len(state.CLASS_NAMES)}\n")
        f.write(f"names: {state.CLASS_NAMES}\n")

    return jsonify({
        "status": "exported",
        "train_count": len(train_imgs),
        "val_count": len(val_imgs),
        "test_count": len(test_imgs),
        "total": total,
        "export_dir": str(target_dir),
        "data_yaml": str(data_yaml),
    })
