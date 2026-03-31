"""
Nexus Annotator — Multi-user YOLO Annotation & Training Platform
=================================================================
Production-grade Flask + SocketIO application with:
  - SQLite-backed auth & rooms
  - Real-time WebSocket sync (label edits, room events, training logs)
  - Dedicated Training view with full ultralytics parameter support
  - Collaborative annotation with user color tracking
"""

import os
import json
import random
import shutil
import sqlite3
import secrets
import uuid
import platform
import threading
import subprocess
import signal
import time
from pathlib import Path
from functools import wraps
from datetime import datetime

from flask import Flask, render_template, jsonify, request, send_from_directory, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import generate_password_hash, check_password_hash

# =============================================================================
# Application Factory
# =============================================================================

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", secrets.token_hex(32))
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# =============================================================================
# Constants & Configuration
# =============================================================================

DB_PATH = Path(__file__).resolve().parent / "nexus.db"
BASE_DIR = Path(__file__).resolve().parent.parent
CLASS_CONFIG_FILE = Path(__file__).resolve().parent / "classes.json"

USER_COLORS = [
    "#e94560", "#4caf50", "#2196f3", "#ff9800", "#9c27b0",
    "#00bcd4", "#ff5722", "#795548", "#607d8b", "#3f51b5",
    "#009688", "#cddc39", "#ff4081", "#00e5ff", "#76ff03",
]

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff"}
PER_PAGE_DEFAULT = 100
PER_PAGE_MAX = 200

# =============================================================================
# Shared State (thread-safe)
# =============================================================================

_state_lock = threading.Lock()

# Room-scoped image directories (set when entering a room)
RAW_IMAGES_DIR = BASE_DIR / "dataset" / "images"
RAW_LABELS_DIR = BASE_DIR / "dataset" / "labels"
EXPORT_DIR = BASE_DIR / "dataset-ready-to-train"
CURRENT_ROOM_ID = None

# Image index & annotation cache
_image_names: list = []
_image_cache: dict = {}
_cache_ready = False

# Class configuration
CLASS_NAMES: list = ["tugboat"]

# Training state — multi-session
_training_sessions: dict = {}  # session_id -> session dict
_training_sessions_lock = threading.Lock()


def _load_class_config():
    global CLASS_NAMES
    if CLASS_CONFIG_FILE.exists():
        with open(CLASS_CONFIG_FILE) as f:
            data = json.load(f)
            if isinstance(data, list) and data:
                CLASS_NAMES = data


def _save_class_config():
    with open(CLASS_CONFIG_FILE, "w") as f:
        json.dump(CLASS_NAMES, f, indent=2)


# =============================================================================
# Database
# =============================================================================

def get_db():
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


def init_db():
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            color TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            images_dir TEXT DEFAULT '',
            labels_dir TEXT DEFAULT '',
            export_dir TEXT DEFAULT '',
            folder_mode TEXT DEFAULT 'images_labels',
            created_by INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER REFERENCES rooms(id),
            user_id INTEGER REFERENCES users(id),
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS image_edits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER,
            image_name TEXT NOT NULL,
            user_id INTEGER REFERENCES users(id),
            edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_edits_room_image
            ON image_edits(room_id, image_name);
    """)
    db.commit()
    db.close()
    print("[DB] Initialized")


# =============================================================================
# Auth Decorator
# =============================================================================

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Login required"}), 401
        return f(*args, **kwargs)
    return decorated


def _get_current_user():
    if "user_id" not in session:
        return None
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE id = ?", (session["user_id"],)).fetchone()
    db.close()
    return user


# =============================================================================
# Image Index & Cache
# =============================================================================

def _index_images():
    global _image_names
    if RAW_IMAGES_DIR.is_dir():
        _image_names = sorted(
            f.name for f in RAW_IMAGES_DIR.iterdir()
            if f.suffix.lower() in IMAGE_EXTENSIONS
        )
    else:
        _image_names = []
    print(f"[INDEX] {len(_image_names)} images")


def _build_cache():
    global _cache_ready
    cache = {}
    for name in _image_names:
        label_path = RAW_LABELS_DIR / (Path(name).stem + ".txt")
        bbox_count = 0
        if label_path.exists():
            with open(label_path) as f:
                bbox_count = sum(1 for line in f if line.strip())
        cache[name] = {"annotated": bbox_count > 0, "bbox_count": bbox_count}
    with _state_lock:
        _image_cache.clear()
        _image_cache.update(cache)
        _cache_ready = True
    print(f"[CACHE] {sum(1 for v in cache.values() if v['annotated'])} annotated")


def _get_annotation_info(image_name):
    with _state_lock:
        if image_name in _image_cache:
            return _image_cache[image_name]
    label_path = RAW_LABELS_DIR / (Path(image_name).stem + ".txt")
    bbox_count = 0
    if label_path.exists():
        with open(label_path) as f:
            bbox_count = sum(1 for line in f if line.strip())
    info = {"annotated": bbox_count > 0, "bbox_count": bbox_count}
    with _state_lock:
        _image_cache[image_name] = info
    return info


def _reload_dataset():
    with _state_lock:
        _image_cache.clear()
        global _cache_ready
        _cache_ready = False
    _index_images()
    threading.Thread(target=_build_cache, daemon=True).start()


# =============================================================================
# Label I/O
# =============================================================================

def _read_labels(image_name):
    label_path = RAW_LABELS_DIR / f"{Path(image_name).stem}.txt"
    labels = []
    if label_path.exists():
        with open(label_path) as f:
            for line in f:
                parts = line.strip().split()
                if len(parts) >= 5:
                    labels.append({
                        "class_id": int(parts[0]),
                        "cx": float(parts[1]),
                        "cy": float(parts[2]),
                        "w": float(parts[3]),
                        "h": float(parts[4]),
                    })
    return labels


def _write_labels(image_name, labels):
    label_path = RAW_LABELS_DIR / f"{Path(image_name).stem}.txt"
    RAW_LABELS_DIR.mkdir(parents=True, exist_ok=True)
    with open(label_path, "w") as f:
        for lbl in labels:
            f.write(f"{lbl['class_id']} {lbl['cx']:.6f} {lbl['cy']:.6f} {lbl['w']:.6f} {lbl['h']:.6f}\n")


# =============================================================================
# Routes: Auth
# =============================================================================

@app.route("/api/register", methods=["POST"])
def api_register():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    display_name = data.get("display_name", "").strip() or username

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400
    if len(username) < 3:
        return jsonify({"error": "Username must be at least 3 characters"}), 400
    if len(password) < 4:
        return jsonify({"error": "Password must be at least 4 characters"}), 400

    db = get_db()
    if db.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
        db.close()
        return jsonify({"error": "Username already taken"}), 400

    count = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    color = USER_COLORS[count % len(USER_COLORS)]
    pw_hash = generate_password_hash(password)

    cursor = db.execute(
        "INSERT INTO users (username, password_hash, display_name, color) VALUES (?, ?, ?, ?)",
        (username, pw_hash, display_name, color),
    )
    user_id = cursor.lastrowid
    db.commit()
    db.close()

    session["user_id"] = user_id
    return jsonify({
        "status": "ok", "user_id": user_id,
        "username": username, "display_name": display_name, "color": color,
    })


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if not username or not password:
        return jsonify({"error": "Username and password required"}), 400

    db = get_db()
    user = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    db.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid username or password"}), 401

    session["user_id"] = user["id"]
    return jsonify({
        "status": "ok", "user_id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "color": user["color"],
    })


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify({"status": "ok"})


@app.route("/api/me")
def api_me():
    user = _get_current_user()
    if not user:
        return jsonify({"logged_in": False})
    return jsonify({
        "logged_in": True, "user_id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "color": user["color"],
    })


# =============================================================================
# Routes: Rooms
# =============================================================================

@app.route("/api/rooms")
@login_required
def api_rooms():
    db = get_db()
    rooms = db.execute("""
        SELECT r.*, u.username AS creator_name,
            (SELECT COUNT(*) FROM room_members rm2 WHERE rm2.room_id = r.id) AS member_count
        FROM rooms r
        JOIN room_members rm ON rm.room_id = r.id
        LEFT JOIN users u ON r.created_by = u.id
        WHERE rm.user_id = ?
        ORDER BY rm.joined_at DESC
    """, (session["user_id"],)).fetchall()
    db.close()
    return jsonify({"rooms": [dict(r) for r in rooms]})


@app.route("/api/rooms/create", methods=["POST"])
@login_required
def api_create_room():
    data = request.get_json() or {}
    name = data.get("name", "").strip()
    if not name:
        return jsonify({"error": "Room name required"}), 400

    code = uuid.uuid4().hex[:6].upper()
    db = get_db()
    cursor = db.execute(
        "INSERT INTO rooms (code, name, created_by) VALUES (?, ?, ?)",
        (code, name, session["user_id"]),
    )
    room_id = cursor.lastrowid
    db.execute(
        "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)",
        (room_id, session["user_id"]),
    )
    db.commit()
    db.close()
    return jsonify({"status": "ok", "room_id": room_id, "code": code, "name": name})


@app.route("/api/rooms/join", methods=["POST"])
@login_required
def api_join_room():
    data = request.get_json() or {}
    code = data.get("code", "").strip().upper()
    if not code:
        return jsonify({"error": "Room code required"}), 400

    db = get_db()
    room = db.execute("SELECT * FROM rooms WHERE code = ?", (code,)).fetchone()
    if not room:
        db.close()
        return jsonify({"error": "Room not found"}), 404

    existing = db.execute(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?",
        (room["id"], session["user_id"]),
    ).fetchone()
    if not existing:
        db.execute(
            "INSERT INTO room_members (room_id, user_id) VALUES (?, ?)",
            (room["id"], session["user_id"]),
        )
        db.commit()
    db.close()
    return jsonify({"status": "ok", "room_id": room["id"], "code": code, "name": room["name"]})


@app.route("/api/rooms/<int:room_id>")
@login_required
def api_room_info(room_id):
    db = get_db()
    room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if not room:
        db.close()
        return jsonify({"error": "Room not found"}), 404

    members = db.execute("""
        SELECT u.id, u.username, u.display_name, u.color, rm.joined_at
        FROM users u JOIN room_members rm ON rm.user_id = u.id
        WHERE rm.room_id = ?
    """, (room_id,)).fetchall()
    db.close()
    return jsonify({"room": dict(room), "members": [dict(m) for m in members]})


@app.route("/api/rooms/<int:room_id>/enter", methods=["POST"])
@login_required
def api_enter_room(room_id):
    global RAW_IMAGES_DIR, RAW_LABELS_DIR, EXPORT_DIR, CURRENT_ROOM_ID

    db = get_db()
    member = db.execute(
        "SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?",
        (room_id, session["user_id"]),
    ).fetchone()
    if not member:
        db.close()
        return jsonify({"error": "Not a member of this room"}), 403

    room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    db.close()
    if not room:
        return jsonify({"error": "Room not found"}), 404

    CURRENT_ROOM_ID = room_id
    session["room_id"] = room_id

    if room["images_dir"]:
        RAW_IMAGES_DIR = Path(room["images_dir"])
        RAW_LABELS_DIR = Path(room["labels_dir"]) if room["labels_dir"] else RAW_IMAGES_DIR.parent / "labels"
        EXPORT_DIR = Path(room["export_dir"]) if room["export_dir"] else RAW_IMAGES_DIR.parent / "export"
        _reload_dataset()
    else:
        RAW_IMAGES_DIR = Path("/tmp/nexus-blank")
        RAW_LABELS_DIR = Path("/tmp/nexus-blank")
        RAW_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        with _state_lock:
            _image_cache.clear()
            global _image_names, _cache_ready
            _image_names = []
            _cache_ready = True

    return jsonify({
        "status": "ok", "room_id": room_id,
        "room_name": room["name"], "room_code": room["code"],
        "images_dir": str(RAW_IMAGES_DIR), "labels_dir": str(RAW_LABELS_DIR),
        "export_dir": str(EXPORT_DIR), "image_count": len(_image_names),
        "blank": not bool(room["images_dir"]),
    })


# =============================================================================
# Routes: Pages
# =============================================================================

@app.route("/")
def index():
    return render_template("index.html", class_names=CLASS_NAMES)


# =============================================================================
# Routes: Folder Management
# =============================================================================

@app.route("/api/open-folder", methods=["POST"])
@login_required
def api_open_folder():
    global RAW_IMAGES_DIR, RAW_LABELS_DIR
    data = request.get_json() or {}
    mode = data.get("mode", "images_labels")
    folder = data.get("folder", "").strip()
    images_dir = data.get("images_dir", "").strip()
    labels_dir = data.get("labels_dir", "").strip()

    if mode == "images_only":
        if not folder:
            return jsonify({"error": "folder is required"}), 400
        img_path = Path(folder).resolve()
        if not img_path.is_dir():
            return jsonify({"error": f"Not a directory: {folder}"}), 400
        lbl_path = img_path.parent / "labels"
        lbl_path.mkdir(parents=True, exist_ok=True)

    elif mode == "mixed":
        if not folder:
            return jsonify({"error": "folder is required"}), 400
        img_path = Path(folder).resolve()
        if not img_path.is_dir():
            return jsonify({"error": f"Not a directory: {folder}"}), 400
        lbl_path = img_path

    else:  # images_labels
        if not images_dir:
            return jsonify({"error": "images_dir is required"}), 400
        img_path = Path(images_dir).resolve()
        if not img_path.is_dir():
            return jsonify({"error": f"Not a directory: {images_dir}"}), 400
        lbl_path = Path(labels_dir).resolve() if labels_dir else img_path.parent / "labels"
        if not lbl_path.is_dir():
            lbl_path.mkdir(parents=True, exist_ok=True)

    RAW_IMAGES_DIR = img_path
    RAW_LABELS_DIR = lbl_path

    room_id = session.get("room_id") or CURRENT_ROOM_ID
    if room_id:
        db = get_db()
        db.execute(
            "UPDATE rooms SET images_dir=?, labels_dir=?, folder_mode=? WHERE id=?",
            (str(img_path), str(lbl_path), mode, room_id),
        )
        db.commit()
        db.close()

    _reload_dataset()

    # Notify all room clients via WebSocket
    if room_id:
        socketio.emit("folder_changed", {
            "images_dir": str(RAW_IMAGES_DIR),
            "labels_dir": str(RAW_LABELS_DIR),
            "image_count": len(_image_names),
        }, room=f"room_{room_id}")

    return jsonify({
        "status": "ok", "mode": mode,
        "images_dir": str(RAW_IMAGES_DIR),
        "labels_dir": str(RAW_LABELS_DIR),
        "image_count": len(_image_names),
    })


@app.route("/api/save-folder", methods=["POST"])
@login_required
def api_save_folder():
    global EXPORT_DIR
    data = request.get_json() or {}
    save_dir = data.get("save_dir", "").strip()
    if not save_dir:
        return jsonify({"error": "save_dir is required"}), 400
    path = Path(save_dir).resolve()
    path.mkdir(parents=True, exist_ok=True)
    EXPORT_DIR = path

    room_id = session.get("room_id") or CURRENT_ROOM_ID
    if room_id:
        db = get_db()
        db.execute("UPDATE rooms SET export_dir=? WHERE id=?", (str(path), room_id))
        db.commit()
        db.close()

    return jsonify({"status": "ok", "save_dir": str(EXPORT_DIR)})


@app.route("/api/current-dirs")
def api_current_dirs():
    return jsonify({
        "images_dir": str(RAW_IMAGES_DIR),
        "labels_dir": str(RAW_LABELS_DIR),
        "export_dir": str(EXPORT_DIR),
        "room_id": CURRENT_ROOM_ID,
    })


@app.route("/api/browse", methods=["POST"])
def api_browse():
    data = request.get_json() or {}
    browse_path = data.get("path", "").strip()

    if not browse_path:
        if platform.system() == "Windows":
            import string
            drives = [f"{d}:\\" for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
            return jsonify({"path": "", "dirs": drives, "is_root": True})
        else:
            browse_path = "/"

    p = Path(browse_path).resolve()
    if not p.is_dir():
        return jsonify({"error": "Not a directory"}), 400

    dirs = []
    try:
        for item in sorted(p.iterdir()):
            if item.is_dir() and not item.name.startswith("."):
                dirs.append(item.name)
    except PermissionError:
        return jsonify({"error": "Permission denied"}), 403

    return jsonify({
        "path": str(p),
        "parent": str(p.parent) if p != p.parent else None,
        "dirs": dirs[:200],
        "is_root": p == p.parent,
    })


# =============================================================================
# Routes: Classes
# =============================================================================

@app.route("/api/classes")
def api_classes():
    return jsonify({"classes": CLASS_NAMES})


@app.route("/api/classes", methods=["POST"])
@login_required
def api_save_classes():
    global CLASS_NAMES
    data = request.get_json() or {}
    classes = data.get("classes", [])
    if not isinstance(classes, list) or not classes:
        return jsonify({"error": "classes must be a non-empty list"}), 400
    CLASS_NAMES = [str(c).strip() for c in classes if str(c).strip()]
    if not CLASS_NAMES:
        return jsonify({"error": "At least one class name required"}), 400
    _save_class_config()
    return jsonify({"status": "ok", "classes": CLASS_NAMES})


# =============================================================================
# Routes: Images & Labels
# =============================================================================

@app.route("/api/images")
def api_images():
    page = int(request.args.get("page", 0))
    per_page = min(PER_PAGE_MAX, int(request.args.get("per_page", PER_PAGE_DEFAULT)))
    filter_type = request.args.get("filter", "all")
    search = request.args.get("search", "").lower()

    filtered = []
    for name in _image_names:
        if search and search not in name.lower():
            continue
        if filter_type != "all":
            info = _get_annotation_info(name)
            if filter_type == "annotated" and not info["annotated"]:
                continue
            if filter_type == "unannotated" and info["annotated"]:
                continue
        filtered.append(name)

    total = len(filtered)
    start = page * per_page
    page_items = filtered[start:start + per_page]

    result = []
    for name in page_items:
        info = _get_annotation_info(name)
        result.append({
            "name": name,
            "annotated": info["annotated"],
            "bbox_count": info["bbox_count"],
        })

    return jsonify({
        "images": result, "total": total, "page": page,
        "per_page": per_page,
        "total_pages": max(1, (total + per_page - 1) // per_page),
    })


@app.route("/api/image/<path:filename>")
def api_image(filename):
    if "/" in filename or "\\" in filename or ".." in filename:
        return jsonify({"error": "Invalid filename"}), 400
    return send_from_directory(str(RAW_IMAGES_DIR), filename)


@app.route("/api/labels/<path:image_name>")
def api_labels(image_name):
    if "/" in image_name or "\\" in image_name or ".." in image_name:
        return jsonify({"error": "Invalid filename"}), 400
    return jsonify({
        "image": image_name,
        "labels": _read_labels(image_name),
        "class_names": CLASS_NAMES,
    })


@app.route("/api/labels/<path:image_name>", methods=["POST"])
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

    _write_labels(image_name, validated)

    with _state_lock:
        _image_cache[image_name] = {
            "annotated": len(validated) > 0,
            "bbox_count": len(validated),
        }

    user_id = session.get("user_id")
    room_id = session.get("room_id") or CURRENT_ROOM_ID
    if user_id and room_id:
        db = get_db()
        db.execute(
            "INSERT INTO image_edits (room_id, image_name, user_id) VALUES (?, ?, ?)",
            (room_id, image_name, user_id),
        )
        db.commit()
        db.close()

        # Broadcast edit via WebSocket
        user = _get_current_user()
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


# =============================================================================
# Routes: Edit Tracking
# =============================================================================

@app.route("/api/image-edits")
def api_image_edits():
    room_id = request.args.get("room_id") or session.get("room_id") or CURRENT_ROOM_ID
    if not room_id:
        return jsonify({"edits": {}})

    db = get_db()
    edits = db.execute("""
        SELECT ie.image_name, ie.edited_at, u.username, u.display_name, u.color
        FROM image_edits ie
        JOIN users u ON ie.user_id = u.id
        WHERE ie.id IN (
            SELECT MAX(id) FROM image_edits WHERE room_id = ? GROUP BY image_name
        )
    """, (room_id,)).fetchall()
    db.close()

    return jsonify({
        "edits": {
            e["image_name"]: {
                "username": e["username"],
                "display_name": e["display_name"],
                "color": e["color"],
                "edited_at": e["edited_at"],
            }
            for e in edits
        }
    })


# =============================================================================
# Routes: Stats & Export
# =============================================================================

@app.route("/api/stats")
def api_stats():
    with _state_lock:
        ready = _cache_ready

    if not ready:
        return jsonify({
            "total_images": len(_image_names),
            "annotated": -1, "unannotated": -1, "total_bboxes": -1,
            "class_names": CLASS_NAMES, "cache_ready": False,
        })

    with _state_lock:
        cache = dict(_image_cache)

    annotated = sum(1 for v in cache.values() if v["annotated"])
    total_bboxes = sum(v["bbox_count"] for v in cache.values())
    return jsonify({
        "total_images": len(_image_names),
        "annotated": annotated,
        "unannotated": len(_image_names) - annotated,
        "total_bboxes": total_bboxes,
        "class_names": CLASS_NAMES,
        "cache_ready": True,
    })


@app.route("/api/export", methods=["POST"])
@login_required
def api_export():
    data = request.get_json() or {}
    train_ratio = max(0.1, min(0.95, float(data.get("train_ratio", 0.8))))
    seed = int(data.get("seed", 42))

    with _state_lock:
        annotated_images = [n for n, v in _image_cache.items() if v["annotated"]]

    if not annotated_images:
        return jsonify({"error": "No annotated images to export"}), 400

    random.seed(seed)
    random.shuffle(annotated_images)

    split_idx = int(len(annotated_images) * train_ratio)
    train_imgs = annotated_images[:split_idx]
    valid_imgs = annotated_images[split_idx:]

    train_img_dir = EXPORT_DIR / "train" / "images"
    train_lbl_dir = EXPORT_DIR / "train" / "labels"
    valid_img_dir = EXPORT_DIR / "valid" / "images"
    valid_lbl_dir = EXPORT_DIR / "valid" / "labels"

    for d in [train_img_dir, train_lbl_dir, valid_img_dir, valid_lbl_dir]:
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

    def copy_split(img_list, img_dir, lbl_dir):
        for img_name in img_list:
            src_img = RAW_IMAGES_DIR / img_name
            src_lbl = RAW_LABELS_DIR / f"{Path(img_name).stem}.txt"
            if src_img.exists():
                shutil.copy2(str(src_img), str(img_dir / img_name))
            if src_lbl.exists():
                shutil.copy2(str(src_lbl), str(lbl_dir / (Path(img_name).stem + ".txt")))

    copy_split(train_imgs, train_img_dir, train_lbl_dir)
    copy_split(valid_imgs, valid_img_dir, valid_lbl_dir)

    data_yaml = EXPORT_DIR / "data.yaml"
    with open(data_yaml, "w") as f:
        f.write("train: ../train/images\n")
        f.write("val: ../valid/images\n\n")
        f.write(f"nc: {len(CLASS_NAMES)}\n")
        f.write(f"names: {CLASS_NAMES}\n")

    return jsonify({
        "status": "exported",
        "train_count": len(train_imgs),
        "valid_count": len(valid_imgs),
        "export_dir": str(EXPORT_DIR),
    })


# =============================================================================
# Routes: YOLO Training (Advanced)
# =============================================================================

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


def _parse_train_params(data):
    """Validate and parse training parameters against schema."""
    params = {}
    for key, schema in TRAIN_PARAMS_SCHEMA.items():
        if key not in data:
            continue
        value = data[key]
        if value is None or value == "":
            continue
        # Skip if same as default
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


@app.route("/api/train/params-schema")
def api_train_params_schema():
    return jsonify({"schema": TRAIN_PARAMS_SCHEMA})


@app.route("/api/train", methods=["POST"])
@login_required
def api_train():
    data = request.get_json() or {}

    session_name = data.get("session_name", "").strip()
    if not session_name:
        session_name = f"train-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

    # Data yaml path
    data_yaml_path = data.get("data_yaml", "").strip()
    if data_yaml_path:
        data_yaml = Path(data_yaml_path).resolve()
    else:
        data_yaml = EXPORT_DIR / "data.yaml"

    if not data_yaml.exists():
        return jsonify({"error": "No data.yaml found. Export dataset first or specify data_yaml path."}), 400

    # Parse all training params
    train_params = _parse_train_params(data)

    model_name = train_params.pop("model", data.get("model", "yolo11n.pt"))

    if "project" not in train_params:
        train_params["project"] = str(EXPORT_DIR / "runs")
    if "name" not in train_params:
        train_params["name"] = session_name
    if "exist_ok" not in train_params:
        train_params["exist_ok"] = True

    # Create session
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

    with _training_sessions_lock:
        _training_sessions[sid] = sess

    def run_training():
        try:
            _add_train_log(sid, f"[INIT] Loading model: {model_name}", "info")

            # Build a temp training script so we can kill the process
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

            _add_train_log(sid, f"[START] {session_name} | {model_name} | data={data_yaml.name}", "info")

            proc = subprocess.Popen(
                [str(Path(os.environ.get('VIRTUAL_ENV', '')) / 'bin' / 'python'), str(script_path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                preexec_fn=os.setsid,
            )

            with _training_sessions_lock:
                _training_sessions[sid]["process"] = proc
                _training_sessions[sid]["status"] = "running"

            # Stream output
            for line in iter(proc.stdout.readline, ""):
                line = line.rstrip()
                if not line:
                    continue

                # Parse epoch progress from ultralytics output
                _parse_progress(sid, line)

                log_type = "info"
                if "[NEXUS_DONE]" in line:
                    log_type = "success"
                elif "error" in line.lower() or "exception" in line.lower():
                    log_type = "error"
                elif "warning" in line.lower():
                    log_type = "warning"
                elif "epoch" in line.lower() or "ETA" in line:
                    log_type = "info"

                _add_train_log(sid, line, log_type)

            proc.wait()

            if proc.returncode == 0:
                _add_train_log(sid, "[DONE] Training complete!", "success")
                with _training_sessions_lock:
                    _training_sessions[sid]["status"] = "completed"
                socketio.emit("train_complete", {"session_id": sid, "status": "success"}, room="training")
            elif proc.returncode == -9 or proc.returncode == -15:
                _add_train_log(sid, "[STOPPED] Training killed by user", "warning")
                with _training_sessions_lock:
                    _training_sessions[sid]["status"] = "stopped"
                socketio.emit("train_complete", {"session_id": sid, "status": "stopped"}, room="training")
            else:
                _add_train_log(sid, f"[ERROR] Process exited with code {proc.returncode}", "error")
                with _training_sessions_lock:
                    _training_sessions[sid]["status"] = "error"
                socketio.emit("train_complete", {"session_id": sid, "status": "error"}, room="training")

            # Cleanup script
            try:
                script_path.unlink(missing_ok=True)
            except Exception:
                pass

        except Exception as e:
            _add_train_log(sid, f"[ERROR] {str(e)}", "error")
            with _training_sessions_lock:
                _training_sessions[sid]["status"] = "error"
            socketio.emit("train_complete", {"session_id": sid, "status": "error", "message": str(e)}, room="training")

    threading.Thread(target=run_training, daemon=True).start()

    return jsonify({
        "status": "started", "session_id": sid, "session_name": session_name,
        "model": model_name, "data_yaml": str(data_yaml),
    })


def _add_train_log(session_id, message, log_type="info"):
    with _training_sessions_lock:
        sess = _training_sessions.get(session_id)
        if sess:
            sess["log"].append({"message": message, "type": log_type, "ts": datetime.now().isoformat()})
    socketio.emit("train_log", {"session_id": session_id, "message": message, "type": log_type}, room="training")


def _parse_progress(session_id, line):
    """Try to extract epoch progress from ultralytics output."""
    # Ultralytics prints lines like: "      3/100      0.123G  ..." 
    try:
        stripped = line.strip()
        parts = stripped.split()
        if len(parts) >= 2 and "/" in parts[0]:
            ep_parts = parts[0].split("/")
            if len(ep_parts) == 2 and ep_parts[0].isdigit() and ep_parts[1].isdigit():
                current_epoch = int(ep_parts[0])
                total_epochs = int(ep_parts[1])
                with _training_sessions_lock:
                    sess = _training_sessions.get(session_id)
                    if sess:
                        sess["progress"] = {
                            "current_epoch": current_epoch,
                            "total_epochs": total_epochs,
                            "percent": round(current_epoch / total_epochs * 100, 1),
                        }
                socketio.emit("train_progress", {
                    "session_id": session_id,
                    "current_epoch": current_epoch,
                    "total_epochs": total_epochs,
                    "percent": round(current_epoch / total_epochs * 100, 1),
                }, room="training")
    except (ValueError, IndexError, ZeroDivisionError):
        pass


@app.route("/api/train/sessions")
def api_train_sessions():
    """List all training sessions."""
    with _training_sessions_lock:
        sessions = []
        for sid, sess in _training_sessions.items():
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


@app.route("/api/train/status")
def api_train_status():
    """Get status of a specific session or summary of all sessions."""
    session_id = request.args.get("session_id")
    if session_id:
        with _training_sessions_lock:
            sess = _training_sessions.get(session_id)
            if not sess:
                return jsonify({"error": "Session not found"}), 404
            return jsonify({
                "id": sess["id"],
                "name": sess["name"],
                "status": sess["status"],
                "model": sess["model"],
                "data_yaml": sess["data_yaml"],
                "progress": sess.get("progress", {}),
                "log": [{"message": l["message"], "type": l["type"]} for l in sess["log"]],
                "created_at": sess["created_at"],
            })
    # Summary
    with _training_sessions_lock:
        active = sum(1 for s in _training_sessions.values() if s["status"] in ("running", "starting"))
        return jsonify({"active_count": active, "total_count": len(_training_sessions)})


@app.route("/api/train/stop/<session_id>", methods=["POST"])
@login_required
def api_train_stop(session_id):
    with _training_sessions_lock:
        sess = _training_sessions.get(session_id)
        if not sess:
            return jsonify({"error": "Session not found"}), 404
        if sess["status"] not in ("running", "starting"):
            return jsonify({"error": "Session is not running"}), 400
        proc = sess.get("process")

    if proc and proc.poll() is None:
        try:
            # Kill the entire process group (training + any child processes)
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            _add_train_log(session_id, "[KILLED] Training force-stopped by user", "warning")
        except (ProcessLookupError, PermissionError) as e:
            _add_train_log(session_id, f"[WARN] Kill attempt: {e}", "warning")
            try:
                proc.kill()
            except Exception:
                pass
        with _training_sessions_lock:
            sess["status"] = "stopped"
        socketio.emit("train_complete", {"session_id": session_id, "status": "stopped"}, room="training")
        return jsonify({"status": "killed"})
    else:
        with _training_sessions_lock:
            sess["status"] = "stopped"
        return jsonify({"status": "already_finished"})


@app.route("/api/train/remove/<session_id>", methods=["POST"])
@login_required
def api_train_remove(session_id):
    """Remove a training session from the list."""
    with _training_sessions_lock:
        sess = _training_sessions.get(session_id)
        if not sess:
            return jsonify({"error": "Session not found"}), 404
        if sess["status"] in ("running", "starting"):
            return jsonify({"error": "Cannot remove a running session. Stop it first."}), 400
        del _training_sessions[session_id]
    return jsonify({"status": "removed"})


@app.route("/api/train/resume/<session_id>", methods=["POST"])
@login_required
def api_train_resume(session_id):
    """Resume/continue a stopped or errored training session with the same params."""
    with _training_sessions_lock:
        sess = _training_sessions.get(session_id)
        if not sess:
            return jsonify({"error": "Session not found"}), 404
        if sess["status"] in ("running", "starting"):
            return jsonify({"error": "Session is already running"}), 400

        # Re-use original params but set resume=True for ultralytics
        train_params = dict(sess["params"])
        model_name = sess["model"]
        data_yaml = Path(sess["data_yaml"])
        session_name = sess["name"]

    # Clear old log and reset progress
    with _training_sessions_lock:
        sess["status"] = "starting"
        sess["log"] = []
        sess["progress"] = {}
        sess["process"] = None

    def run_resumed_training():
        try:
            _add_train_log(session_id, f"[RESUME] Resuming: {session_name} | {model_name}", "info")

            # Build temp training script — use resume=True so ultralytics picks up last.pt
            script_path = Path(train_params.get("project", ".")) / f".nexus_train_{session_id}.py"
            script_path.parent.mkdir(parents=True, exist_ok=True)

            # Set resume=True to continue from last checkpoint
            resume_params = {**train_params, "data": str(data_yaml), "resume": True}
            param_str = json.dumps(resume_params)
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

            with _training_sessions_lock:
                _training_sessions[session_id]["process"] = proc
                _training_sessions[session_id]["status"] = "running"

            for line in iter(proc.stdout.readline, ""):
                line = line.rstrip()
                if not line:
                    continue
                _parse_progress(session_id, line)

                log_type = "info"
                if "[NEXUS_DONE]" in line:
                    log_type = "success"
                elif "error" in line.lower() or "exception" in line.lower():
                    log_type = "error"
                elif "warning" in line.lower():
                    log_type = "warning"

                _add_train_log(session_id, line, log_type)

            proc.wait()

            if proc.returncode == 0:
                _add_train_log(session_id, "[DONE] Training complete!", "success")
                with _training_sessions_lock:
                    _training_sessions[session_id]["status"] = "completed"
                socketio.emit("train_complete", {"session_id": session_id, "status": "success"}, room="training")
            elif proc.returncode in (-9, -15):
                _add_train_log(session_id, "[STOPPED] Training killed by user", "warning")
                with _training_sessions_lock:
                    _training_sessions[session_id]["status"] = "stopped"
                socketio.emit("train_complete", {"session_id": session_id, "status": "stopped"}, room="training")
            else:
                _add_train_log(session_id, f"[ERROR] Process exited with code {proc.returncode}", "error")
                with _training_sessions_lock:
                    _training_sessions[session_id]["status"] = "error"
                socketio.emit("train_complete", {"session_id": session_id, "status": "error"}, room="training")

            try:
                script_path.unlink(missing_ok=True)
            except Exception:
                pass

        except Exception as e:
            _add_train_log(session_id, f"[ERROR] {str(e)}", "error")
            with _training_sessions_lock:
                _training_sessions[session_id]["status"] = "error"
            socketio.emit("train_complete", {"session_id": session_id, "status": "error"}, room="training")

    threading.Thread(target=run_resumed_training, daemon=True).start()

    return jsonify({
        "status": "resumed", "session_id": session_id, "session_name": session_name,
    })


@app.route("/api/gpu-info")
def api_gpu_info():
    """Get GPU memory info from nvidia-smi."""
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


# =============================================================================
# WebSocket Events
# =============================================================================

@socketio.on("connect")
def ws_connect():
    print(f"[WS] Connected: {request.sid}")


@socketio.on("disconnect")
def ws_disconnect():
    print(f"[WS] Disconnected: {request.sid}")


@socketio.on("join_room")
def ws_join_room(data):
    room_id = data.get("room_id")
    if room_id:
        room_name = f"room_{room_id}"
        join_room(room_name)
        user = _get_current_user()
        if user:
            emit("user_joined", {
                "username": user["username"],
                "display_name": user["display_name"],
                "color": user["color"],
            }, room=room_name, include_self=False)
        print(f"[WS] {request.sid} joined {room_name}")


@socketio.on("leave_room")
def ws_leave_room(data):
    room_id = data.get("room_id")
    if room_id:
        room_name = f"room_{room_id}"
        leave_room(room_name)
        user = _get_current_user()
        if user:
            emit("user_left", {
                "username": user["username"],
                "display_name": user["display_name"],
            }, room=room_name, include_self=False)
        print(f"[WS] {request.sid} left {room_name}")


@socketio.on("join_training")
def ws_join_training():
    join_room("training")
    print(f"[WS] {request.sid} joined training")


@socketio.on("leave_training")
def ws_leave_training():
    leave_room("training")


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    init_db()
    _load_class_config()

    print(f"[CONFIG] Images: {RAW_IMAGES_DIR}")
    print(f"[CONFIG] Labels: {RAW_LABELS_DIR}")
    print(f"[CONFIG] Export: {EXPORT_DIR}")
    print(f"[CONFIG] Classes: {CLASS_NAMES}")

    _index_images()
    threading.Thread(target=_build_cache, daemon=True).start()

    socketio.run(app, host="172.20.10.10", port=5000, debug=False, allow_unsafe_werkzeug=True)
