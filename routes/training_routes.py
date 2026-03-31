"""
YOLO training routes: start, stop, resume, status, sessions, GPU info.
"""

import json
import os
import subprocess
import threading
import uuid
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request, session

from auth import login_required
from extensions import socketio
from services.training_service import (
    TRAIN_PARAMS_SCHEMA,
    parse_train_params,
    add_train_log,
    parse_progress,
    run_training_subprocess,
    stop_training,
)
import state

bp = Blueprint("training_routes", __name__)


@bp.route("/api/train/params-schema")
def api_train_params_schema():
    return jsonify({"schema": TRAIN_PARAMS_SCHEMA})


@bp.route("/api/train", methods=["POST"])
@login_required
def api_train():
    data = request.get_json() or {}

    session_name = data.get("session_name", "").strip()
    if not session_name:
        session_name = f"train-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

    data_yaml_path = data.get("data_yaml", "").strip()
    if data_yaml_path:
        data_yaml = Path(data_yaml_path).resolve()
    else:
        data_yaml = state.EXPORT_DIR / "data.yaml"

    if not data_yaml.exists():
        return jsonify({"error": "No data.yaml found. Export dataset first or specify data_yaml path."}), 400

    train_params = parse_train_params(data)
    model_name = train_params.pop("model", data.get("model", "yolo11n.pt"))

    if "project" not in train_params:
        train_params["project"] = str(state.EXPORT_DIR / "runs")
    if "name" not in train_params:
        train_params["name"] = session_name
    if "exist_ok" not in train_params:
        train_params["exist_ok"] = True

    sid = uuid.uuid4().hex[:8]
    sess = {
        "id": sid,
        "name": session_name,
        "status": "starting",
        "model": model_name,
        "data_yaml": str(data_yaml),
        "params": train_params,
        "log": [],
        "progress": {},
        "process": None,
        "created_at": datetime.now().isoformat(),
    }

    with state.training_sessions_lock:
        state.training_sessions[sid] = sess

    threading.Thread(
        target=run_training_subprocess,
        args=(sid, session_name, model_name, data_yaml, train_params),
        daemon=True,
    ).start()

    return jsonify({
        "status": "started", "session_id": sid, "session_name": session_name,
        "model": model_name, "data_yaml": str(data_yaml),
    })


@bp.route("/api/train/sessions")
def api_train_sessions():
    with state.training_sessions_lock:
        sessions = []
        for sid, sess in state.training_sessions.items():
            sessions.append({
                "id": sess["id"],
                "name": sess["name"],
                "status": sess["status"],
                "model": sess["model"],
                "progress": sess.get("progress", {}),
                "created_at": sess["created_at"],
                "log_count": len(sess["log"]),
            })
    return jsonify({"sessions": sessions})


@bp.route("/api/train/status")
def api_train_status():
    session_id = request.args.get("session_id")
    if session_id:
        with state.training_sessions_lock:
            sess = state.training_sessions.get(session_id)
            if not sess:
                return jsonify({"error": "Session not found"}), 404
            return jsonify({
                "id": sess["id"],
                "name": sess["name"],
                "status": sess["status"],
                "model": sess["model"],
                "data_yaml": sess["data_yaml"],
                "progress": sess.get("progress", {}),
                "metrics_history": sess.get("metrics_history", []),
                "log": [{"message": l["message"], "type": l["type"]} for l in sess["log"]],
                "created_at": sess["created_at"],
            })
    with state.training_sessions_lock:
        active = sum(1 for s in state.training_sessions.values() if s["status"] in ("running", "starting"))
        return jsonify({"active_count": active, "total_count": len(state.training_sessions)})


@bp.route("/api/train/stop/<session_id>", methods=["POST"])
@login_required
def api_train_stop(session_id):
    result, status_code = stop_training(session_id)
    return jsonify(result), status_code


@bp.route("/api/train/remove/<session_id>", methods=["POST"])
@login_required
def api_train_remove(session_id):
    with state.training_sessions_lock:
        sess = state.training_sessions.get(session_id)
        if not sess:
            return jsonify({"error": "Session not found"}), 404
        if sess["status"] in ("running", "starting"):
            return jsonify({"error": "Cannot remove a running session. Stop it first."}), 400
        del state.training_sessions[session_id]
    return jsonify({"status": "removed"})


@bp.route("/api/train/resume/<session_id>", methods=["POST"])
@login_required
def api_train_resume(session_id):
    with state.training_sessions_lock:
        sess = state.training_sessions.get(session_id)
        if not sess:
            return jsonify({"error": "Session not found"}), 404
        if sess["status"] in ("running", "starting"):
            return jsonify({"error": "Session is already running"}), 400

        train_params = dict(sess["params"])
        model_name = sess["model"]
        data_yaml = Path(sess["data_yaml"])
        session_name = sess["name"]

    with state.training_sessions_lock:
        sess["status"] = "starting"
        sess["log"] = []
        sess["progress"] = {}
        sess["process"] = None

    def run_resumed():
        try:
            add_train_log(session_id, f"[RESUME] Resuming: {session_name} | {model_name}", "info")

            resume_params = {**train_params, "data": str(data_yaml), "resume": True}
            param_str = json.dumps(resume_params)

            script_path = Path(train_params.get("project", ".")) / f".nexus_train_{session_id}.py"
            script_path.parent.mkdir(parents=True, exist_ok=True)
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

            proc = subprocess.Popen(
                [str(Path(os.environ.get('VIRTUAL_ENV', '')) / 'bin' / 'python'), str(script_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                preexec_fn=os.setsid,
            )

            with state.training_sessions_lock:
                state.training_sessions[session_id]["process"] = proc
                state.training_sessions[session_id]["status"] = "running"

            for line in iter(proc.stdout.readline, ""):
                line = line.rstrip()
                if not line:
                    continue
                parse_progress(session_id, line)

                log_type = "info"
                if "[NEXUS_DONE]" in line:
                    log_type = "success"
                elif "error" in line.lower() or "exception" in line.lower():
                    log_type = "error"
                elif "warning" in line.lower():
                    log_type = "warning"

                add_train_log(session_id, line, log_type)

            proc.wait()

            if proc.returncode == 0:
                add_train_log(session_id, "[DONE] Training complete!", "success")
                with state.training_sessions_lock:
                    state.training_sessions[session_id]["status"] = "completed"
                socketio.emit("train_complete", {"session_id": session_id, "status": "success"}, room="training")
            elif proc.returncode in (-9, -15):
                add_train_log(session_id, "[STOPPED] Training killed by user", "warning")
                with state.training_sessions_lock:
                    state.training_sessions[session_id]["status"] = "stopped"
                socketio.emit("train_complete", {"session_id": session_id, "status": "stopped"}, room="training")
            else:
                add_train_log(session_id, f"[ERROR] Process exited with code {proc.returncode}", "error")
                with state.training_sessions_lock:
                    state.training_sessions[session_id]["status"] = "error"
                socketio.emit("train_complete", {"session_id": session_id, "status": "error"}, room="training")

            try:
                script_path.unlink(missing_ok=True)
            except Exception:
                pass

        except Exception as e:
            add_train_log(session_id, f"[ERROR] {str(e)}", "error")
            with state.training_sessions_lock:
                state.training_sessions[session_id]["status"] = "error"
            socketio.emit("train_complete", {"session_id": session_id, "status": "error"}, room="training")

    threading.Thread(target=run_resumed, daemon=True).start()

    return jsonify({
        "status": "resumed", "session_id": session_id, "session_name": session_name,
    })


@bp.route("/api/gpu-info")
def api_gpu_info():
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode != 0:
            return jsonify({"available": False, "error": "nvidia-smi failed"})

        gpus = []
        for line in result.stdout.strip().split("\n"):
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 6:
                gpus.append({
                    "index": int(parts[0]),
                    "name": parts[1],
                    "memory_total_mb": int(parts[2]),
                    "memory_used_mb": int(parts[3]),
                    "memory_free_mb": int(parts[4]),
                    "utilization_pct": int(parts[5]),
                })
        return jsonify({"available": True, "gpus": gpus})
    except FileNotFoundError:
        return jsonify({"available": False, "error": "nvidia-smi not found"})
    except subprocess.TimeoutExpired:
        return jsonify({"available": False, "error": "nvidia-smi timeout"})
    except Exception as e:
        return jsonify({"available": False, "error": str(e)})
