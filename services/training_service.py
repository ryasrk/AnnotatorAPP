"""
Training session management, progress parsing, and subprocess control.
"""

import json
import os
import re
import signal
import subprocess
import threading
import uuid
from datetime import datetime
from pathlib import Path

import state
from extensions import socketio


# Training parameters schema
TRAIN_PARAMS_SCHEMA = {
    # Core
    "model": {"type": "str", "default": "yolo11n.pt", "group": "core", "label": "Model"},
    "epochs": {"type": "int", "default": 100, "min": 1, "max": 9999, "group": "core", "label": "Epochs"},
    "time": {"type": "float", "default": None, "group": "core", "label": "Max Time (hours)"},
    "patience": {"type": "int", "default": 100, "min": 0, "max": 9999, "group": "core", "label": "Early Stop Patience"},
    "batch": {"type": "int", "default": 16, "min": -1, "max": 512, "group": "core", "label": "Batch Size"},
    "imgsz": {"type": "int", "default": 640, "min": 32, "max": 4096, "group": "core", "label": "Image Size"},
    "save": {"type": "bool", "default": True, "group": "core", "label": "Save Checkpoints"},
    "save_period": {"type": "int", "default": -1, "min": -1, "max": 9999, "group": "core", "label": "Save Period (epochs)"},
    "cache": {"type": "bool", "default": False, "group": "core", "label": "Cache Dataset"},
    "device": {"type": "str", "default": "", "group": "core", "label": "Device (e.g. 0, cpu, mps)"},
    "workers": {"type": "int", "default": 8, "min": 0, "max": 64, "group": "core", "label": "Data Workers"},
    "project": {"type": "str", "default": "", "group": "core", "label": "Project Dir"},
    "name": {"type": "str", "default": "train", "group": "core", "label": "Run Name"},
    "exist_ok": {"type": "bool", "default": True, "group": "core", "label": "Overwrite Existing"},
    "pretrained": {"type": "bool", "default": True, "group": "core", "label": "Use Pretrained"},
    "optimizer": {"type": "str", "default": "auto", "group": "core", "label": "Optimizer",
                    "options": ["auto", "SGD", "MuSGD", "Adam", "Adamax", "AdamW", "NAdam", "RAdam", "RMSProp"]},
    "seed": {"type": "int", "default": 0, "group": "core", "label": "Random Seed"},
    "deterministic": {"type": "bool", "default": True, "group": "core", "label": "Deterministic"},
    "single_cls": {"type": "bool", "default": False, "group": "core", "label": "Single Class Mode"},
    "rect": {"type": "bool", "default": False, "group": "core", "label": "Rectangular Training"},
    "cos_lr": {"type": "bool", "default": False, "group": "core", "label": "Cosine LR Scheduler"},
    "close_mosaic": {"type": "int", "default": 10, "min": 0, "max": 9999, "group": "core", "label": "Close Mosaic (last N epochs)"},
    "resume": {"type": "bool", "default": False, "group": "core", "label": "Resume Training"},
    "amp": {"type": "bool", "default": True, "group": "core", "label": "Mixed Precision (AMP)"},
    "fraction": {"type": "float", "default": 1.0, "min": 0.01, "max": 1.0, "group": "core", "label": "Dataset Fraction"},
    "freeze": {"type": "int", "default": None, "min": 0, "max": 999, "group": "core", "label": "Freeze Layers"},
    "multi_scale": {"type": "float", "default": 0.0, "min": 0.0, "max": 1.0, "group": "core", "label": "Multi-Scale Factor"},
    "val": {"type": "bool", "default": True, "group": "core", "label": "Validate During Training"},
    "plots": {"type": "bool", "default": True, "group": "core", "label": "Generate Plots"},
    # Learning Rate
    "lr0": {"type": "float", "default": 0.01, "min": 0.0, "max": 1.0, "group": "lr", "label": "Initial LR"},
    "lrf": {"type": "float", "default": 0.01, "min": 0.0, "max": 1.0, "group": "lr", "label": "Final LR Factor"},
    "momentum": {"type": "float", "default": 0.937, "min": 0.0, "max": 1.0, "group": "lr", "label": "Momentum"},
    "weight_decay": {"type": "float", "default": 0.0005, "min": 0.0, "max": 0.1, "group": "lr", "label": "Weight Decay"},
    "warmup_epochs": {"type": "float", "default": 3.0, "min": 0.0, "max": 100.0, "group": "lr", "label": "Warmup Epochs"},
    "warmup_momentum": {"type": "float", "default": 0.8, "min": 0.0, "max": 1.0, "group": "lr", "label": "Warmup Momentum"},
    "warmup_bias_lr": {"type": "float", "default": 0.1, "min": 0.0, "max": 1.0, "group": "lr", "label": "Warmup Bias LR"},
    # Loss Weights
    "box": {"type": "float", "default": 7.5, "min": 0.0, "max": 100.0, "group": "loss", "label": "Box Loss Weight"},
    "cls": {"type": "float", "default": 0.5, "min": 0.0, "max": 100.0, "group": "loss", "label": "Cls Loss Weight"},
    "dfl": {"type": "float", "default": 1.5, "min": 0.0, "max": 100.0, "group": "loss", "label": "DFL Loss Weight"},
    "nbs": {"type": "int", "default": 64, "min": 1, "max": 512, "group": "loss", "label": "Nominal Batch Size"},
    "dropout": {"type": "float", "default": 0.0, "min": 0.0, "max": 1.0, "group": "loss", "label": "Dropout Rate"},
    # Augmentation
    "hsv_h": {"type": "float", "default": 0.015, "min": 0.0, "max": 1.0, "group": "aug", "label": "HSV Hue"},
    "hsv_s": {"type": "float", "default": 0.7, "min": 0.0, "max": 1.0, "group": "aug", "label": "HSV Saturation"},
    "hsv_v": {"type": "float", "default": 0.4, "min": 0.0, "max": 1.0, "group": "aug", "label": "HSV Value"},
    "degrees": {"type": "float", "default": 0.0, "min": 0.0, "max": 180.0, "group": "aug", "label": "Rotation Degrees"},
    "translate": {"type": "float", "default": 0.1, "min": 0.0, "max": 1.0, "group": "aug", "label": "Translation"},
    "scale": {"type": "float", "default": 0.5, "min": 0.0, "max": 1.0, "group": "aug", "label": "Scale"},
    "shear": {"type": "float", "default": 0.0, "min": -180.0, "max": 180.0, "group": "aug", "label": "Shear"},
    "perspective": {"type": "float", "default": 0.0, "min": 0.0, "max": 0.001, "group": "aug", "label": "Perspective"},
    "flipud": {"type": "float", "default": 0.0, "min": 0.0, "max": 1.0, "group": "aug", "label": "Flip Up-Down"},
    "fliplr": {"type": "float", "default": 0.5, "min": 0.0, "max": 1.0, "group": "aug", "label": "Flip Left-Right"},
    "bgr": {"type": "float", "default": 0.0, "min": 0.0, "max": 1.0, "group": "aug", "label": "BGR Flip"},
    "mosaic": {"type": "float", "default": 1.0, "min": 0.0, "max": 1.0, "group": "aug", "label": "Mosaic"},
    "mixup": {"type": "float", "default": 0.0, "min": 0.0, "max": 1.0, "group": "aug", "label": "MixUp"},
    "cutmix": {"type": "float", "default": 0.0, "min": 0.0, "max": 1.0, "group": "aug", "label": "CutMix"},
    "copy_paste": {"type": "float", "default": 0.0, "min": 0.0, "max": 1.0, "group": "aug", "label": "Copy-Paste"},
    "erasing": {"type": "float", "default": 0.4, "min": 0.0, "max": 1.0, "group": "aug", "label": "Random Erasing"},
}


def parse_train_params(data):
    params = {}
    for key, schema in TRAIN_PARAMS_SCHEMA.items():
        if key not in data:
            continue
        value = data[key]
        if value is None or value == "":
            continue
        if value == schema["default"]:
            continue

        ptype = schema["type"]
        try:
            if ptype == "int":
                value = int(value)
                if "min" in schema:
                    value = max(schema["min"], value)
                if "max" in schema:
                    value = min(schema["max"], value)
            elif ptype == "float":
                value = float(value)
                if "min" in schema:
                    value = max(schema["min"], value)
                if "max" in schema:
                    value = min(schema["max"], value)
            elif ptype == "bool":
                if isinstance(value, str):
                    value = value.lower() in ("true", "1", "yes")
                else:
                    value = bool(value)
            elif ptype == "str":
                value = str(value).strip()
        except (ValueError, TypeError):
            continue

        params[key] = value
    return params


def add_train_log(session_id, message, log_type="info"):
    with state.training_sessions_lock:
        sess = state.training_sessions.get(session_id)
        if sess:
            sess["log"].append({"message": message, "type": log_type, "ts": datetime.now().isoformat()})
    socketio.emit("train_log", {"session_id": session_id, "message": message, "type": log_type}, room="training")


def parse_progress(session_id, line):
    try:
        stripped = line.strip()
        parts = stripped.split()
        if len(parts) >= 2 and "/" in parts[0]:
            ep_parts = parts[0].split("/")
            if len(ep_parts) == 2 and ep_parts[0].isdigit() and ep_parts[1].isdigit():
                current_epoch = int(ep_parts[0])
                total_epochs = int(ep_parts[1])
                metrics = {}
                float_vals = []
                for p in parts[1:]:
                    p_clean = p.rstrip('G')
                    try:
                        float_vals.append(float(p_clean))
                    except ValueError:
                        continue
                if len(float_vals) >= 4:
                    metrics["box_loss"] = float_vals[1]
                    metrics["cls_loss"] = float_vals[2]
                    metrics["dfl_loss"] = float_vals[3]

                progress_data = {
                    "current_epoch": current_epoch,
                    "total_epochs": total_epochs,
                    "percent": round(current_epoch / total_epochs * 100, 1),
                }
                progress_data.update(metrics)

                with state.training_sessions_lock:
                    sess = state.training_sessions.get(session_id)
                    if sess:
                        sess["progress"] = progress_data
                        if "metrics_history" not in sess:
                            sess["metrics_history"] = []
                        entry = {"epoch": current_epoch}
                        entry.update(metrics)
                        if not sess["metrics_history"] or sess["metrics_history"][-1]["epoch"] != current_epoch:
                            sess["metrics_history"].append(entry)

                socketio.emit("train_progress", {
                    "session_id": session_id, **progress_data,
                }, room="training")

        if "all" in stripped and ("mAP" in line or re.search(r'\d+\.\d+\s+\d+\.\d+\s*$', stripped)):
            nums = re.findall(r'[\d.]+', stripped)
            floats = []
            for n in nums:
                try:
                    floats.append(float(n))
                except ValueError:
                    pass
            if len(floats) >= 4:
                val_metrics = {
                    "val_precision": floats[-4],
                    "val_recall": floats[-3],
                    "val_mAP50": floats[-2],
                    "val_mAP50_95": floats[-1],
                }
                with state.training_sessions_lock:
                    sess = state.training_sessions.get(session_id)
                    if sess:
                        if "metrics_history" not in sess:
                            sess["metrics_history"] = []
                        if sess["metrics_history"]:
                            sess["metrics_history"][-1].update(val_metrics)
                        sess["progress"].update(val_metrics)
                socketio.emit("train_metrics", {
                    "session_id": session_id, **val_metrics,
                }, room="training")
    except (ValueError, IndexError, ZeroDivisionError):
        pass


def run_training_subprocess(sid, session_name, model_name, data_yaml, train_params):
    try:
        add_train_log(sid, f"[INIT] Loading model: {model_name}", "info")

        script_path = Path(train_params["project"]) / f".nexus_train_{sid}.py"
        script_path.parent.mkdir(parents=True, exist_ok=True)
        param_str = json.dumps({**train_params, "data": str(data_yaml)})
        script_content = (
            f"import json, sys\n"
            f"from ultralytics import YOLO\n"
            f"model = YOLO('{model_name}')\n"
            f"params = json.loads('{param_str}')\n"
            f"data = params.pop('data')\n"
            f"model.train(data=data, **params)\n"
            f"print('[NEXUS_DONE]')\n"
        )
        script_path.write_text(script_content)

        add_train_log(sid, f"[START] {session_name} | {model_name} | data={data_yaml.name}", "info")

        proc = subprocess.Popen(
            [str(Path(os.environ.get('VIRTUAL_ENV', '')) / 'bin' / 'python'), str(script_path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            preexec_fn=os.setsid,
        )

        with state.training_sessions_lock:
            state.training_sessions[sid]["process"] = proc
            state.training_sessions[sid]["status"] = "running"

        for line in iter(proc.stdout.readline, ""):
            line = line.rstrip()
            if not line:
                continue

            parse_progress(sid, line)

            log_type = "info"
            if "[NEXUS_DONE]" in line:
                log_type = "success"
            elif "error" in line.lower() or "exception" in line.lower():
                log_type = "error"
            elif "warning" in line.lower():
                log_type = "warning"

            add_train_log(sid, line, log_type)

        proc.wait()

        if proc.returncode == 0:
            add_train_log(sid, "[DONE] Training complete!", "success")
            with state.training_sessions_lock:
                state.training_sessions[sid]["status"] = "completed"
            socketio.emit("train_complete", {"session_id": sid, "status": "success"}, room="training")
        elif proc.returncode in (-9, -15):
            add_train_log(sid, "[STOPPED] Training killed by user", "warning")
            with state.training_sessions_lock:
                state.training_sessions[sid]["status"] = "stopped"
            socketio.emit("train_complete", {"session_id": sid, "status": "stopped"}, room="training")
        else:
            add_train_log(sid, f"[ERROR] Process exited with code {proc.returncode}", "error")
            with state.training_sessions_lock:
                state.training_sessions[sid]["status"] = "error"
            socketio.emit("train_complete", {"session_id": sid, "status": "error"}, room="training")

        try:
            script_path.unlink(missing_ok=True)
        except Exception:
            pass

    except Exception as e:
        add_train_log(sid, f"[ERROR] {str(e)}", "error")
        with state.training_sessions_lock:
            state.training_sessions[sid]["status"] = "error"
        socketio.emit("train_complete", {"session_id": sid, "status": "error", "message": str(e)}, room="training")


def stop_training(session_id):
    with state.training_sessions_lock:
        sess = state.training_sessions.get(session_id)
        if not sess:
            return {"error": "Session not found"}, 404
        if sess["status"] not in ("running", "starting"):
            return {"error": "Session is not running"}, 400
        proc = sess.get("process")

    if proc and proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            add_train_log(session_id, "[KILLED] Training force-stopped by user", "warning")
        except (ProcessLookupError, PermissionError) as e:
            add_train_log(session_id, f"[WARN] Kill attempt: {e}", "warning")
            try:
                proc.kill()
            except Exception:
                pass
        with state.training_sessions_lock:
            sess["status"] = "stopped"
        socketio.emit("train_complete", {"session_id": session_id, "status": "stopped"}, room="training")
        return {"status": "killed"}, 200
    else:
        with state.training_sessions_lock:
            sess["status"] = "stopped"
        return {"status": "already_finished"}, 200
