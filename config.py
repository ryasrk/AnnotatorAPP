"""
Configuration & constants for Nexus Annotator.
"""

import os
import secrets
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(__file__).resolve().parent
MODELS_DIR = APP_DIR / "models"
DB_PATH = APP_DIR / "nexus.db"
CLASS_CONFIG_FILE = APP_DIR / "classes.json"

# Flask config
SECRET_KEY = os.environ.get("SECRET_KEY", secrets.token_hex(32))
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"

# User colors
USER_COLORS = [
    "#e94560", "#4caf50", "#2196f3", "#ff9800", "#9c27b0",
    "#00bcd4", "#ff5722", "#795548", "#607d8b", "#3f51b5",
    "#009688", "#cddc39", "#ff4081", "#00e5ff", "#76ff03",
]

# Image settings
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff"}
PER_PAGE_DEFAULT = 100
PER_PAGE_MAX = 200

# Server
HOST = os.environ.get("HOST", "172.20.10.10")
PORT = int(os.environ.get("PORT", 5000))

# Allowed roots for folder browsing and opening (security)
ALLOWED_ROOTS = [
    str(BASE_DIR),
    os.environ.get("ALLOWED_ROOT_1", ""),
    os.environ.get("ALLOWED_ROOT_2", ""),
]
ALLOWED_ROOTS = [r for r in ALLOWED_ROOTS if r]  # filter empty
