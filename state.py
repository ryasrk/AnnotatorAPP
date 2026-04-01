"""
Shared thread-safe application state.
"""

import json
import threading
from dataclasses import dataclass, field
from pathlib import Path

from config import BASE_DIR, CLASS_CONFIG_FILE

# Global lock for legacy/fallback operations
state_lock = threading.Lock()


@dataclass
class RoomState:
    """Per-room state — images, labels, cache, classes."""
    room_id: int
    images_dir: Path
    labels_dir: Path
    export_dir: Path
    class_names: list = field(default_factory=lambda: ["object"])
    image_names: list = field(default_factory=list)
    image_cache: dict = field(default_factory=dict)
    cache_ready: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)


# Per-room state registry
active_rooms: dict = {}  # room_id -> RoomState
rooms_lock = threading.Lock()

# Default/fallback globals (used before entering a room)
RAW_IMAGES_DIR = BASE_DIR / "dataset" / "images"
RAW_LABELS_DIR = BASE_DIR / "dataset" / "labels"
EXPORT_DIR = BASE_DIR / "dataset-ready-to-train"
CURRENT_ROOM_ID = None

# Legacy globals — kept for backward compat, delegate to active room
image_names: list = []
image_cache: dict = {}
cache_ready = False
_class_distribution: dict = {}  # Cached class distribution from build_cache

# Class configuration
CLASS_NAMES: list = ["tugboat"]

# Training state — multi-session
training_sessions: dict = {}
training_sessions_lock = threading.Lock()

# Online user tracking: sid -> {user_id, username, display_name, color, room_id}
online_users: dict = {}
online_lock = threading.Lock()


def get_room_state(room_id):
    """Get or create a RoomState for the given room_id."""
    if room_id is None:
        return None
    with rooms_lock:
        return active_rooms.get(room_id)


def set_room_state(room_id, room_state):
    """Register a RoomState."""
    with rooms_lock:
        active_rooms[room_id] = room_state


def sync_globals_from_room(room_id):
    """Sync legacy globals from a room state (backward compat)."""
    global RAW_IMAGES_DIR, RAW_LABELS_DIR, EXPORT_DIR, CURRENT_ROOM_ID
    global image_names, image_cache, cache_ready, CLASS_NAMES
    rs = get_room_state(room_id)
    if rs:
        RAW_IMAGES_DIR = rs.images_dir
        RAW_LABELS_DIR = rs.labels_dir
        EXPORT_DIR = rs.export_dir
        CURRENT_ROOM_ID = room_id
        image_names = rs.image_names
        image_cache = rs.image_cache
        cache_ready = rs.cache_ready
        CLASS_NAMES = rs.class_names


def load_class_config():
    global CLASS_NAMES
    if CLASS_CONFIG_FILE.exists():
        with open(CLASS_CONFIG_FILE) as f:
            data = json.load(f)
            if isinstance(data, list) and data:
                CLASS_NAMES = data


def save_class_config():
    with open(CLASS_CONFIG_FILE, "w") as f:
        json.dump(CLASS_NAMES, f, indent=2)
