"""
Shared thread-safe application state.
"""

import json
import threading
from pathlib import Path

from config import BASE_DIR, CLASS_CONFIG_FILE

# Global lock for image cache operations
state_lock = threading.Lock()

# Room-scoped directories (set when entering a room)
RAW_IMAGES_DIR = BASE_DIR / "dataset" / "images"
RAW_LABELS_DIR = BASE_DIR / "dataset" / "labels"
EXPORT_DIR = BASE_DIR / "dataset-ready-to-train"
CURRENT_ROOM_ID = None

# Image index & annotation cache
image_names: list = []
image_cache: dict = {}
cache_ready = False

# Class configuration
CLASS_NAMES: list = ["tugboat"]

# Training state — multi-session
training_sessions: dict = {}
training_sessions_lock = threading.Lock()

# Online user tracking: sid -> {user_id, username, display_name, color, room_id}
online_users: dict = {}
online_lock = threading.Lock()


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
