# Nexus Annotator

Multi-user YOLO annotation and training platform built with Flask, SocketIO, and vanilla JavaScript.

![Python](https://img.shields.io/badge/Python-3.12-blue)
![Flask](https://img.shields.io/badge/Flask-SocketIO-green)
![YOLO](https://img.shields.io/badge/Ultralytics-YOLO-purple)

## Features

### Annotation
- **Bounding Box** — Click-and-drag rectangle annotation
- **Polygon Segmentation** — Multi-point polygon annotation with vertex editing (add/delete/drag vertices)
- **Auto-Annotate** — Run YOLO inference on images with class filtering, then accept/reject predictions
- **Custom Models** — Browse and select `.pt` model files for inference
- **Undo/Redo** — `Ctrl+Z` undo support for annotations
- **Keyboard Shortcuts** — `B` Draw, `G` Polygon, `V` Select, `Del` Delete, `A/D` Navigate, `Ctrl+S` Save

### Collaboration
- **Multi-User Rooms** — Create/join rooms with unique codes
- **Private/Public Rooms** — Private rooms require owner approval to join
- **Real-Time Sync** — WebSocket-based live updates for labels, assignments, and chat
- **In-App Chat** — Room-scoped messaging with sound notifications
- **Image Assignment** — Assign images to specific annotators with ratio-based distribution
- **Editor Tracking** — See who last edited each image with color-coded indicators

### Training & Export
- **YOLO Training** — Launch model training directly from the app with configurable hyperparameters
- **Export Formats** — YOLO (TXT + data.yaml), COCO (JSON with polygon segmentation), Pascal VOC (XML)
- **Dataset Statistics** — Per-class distribution, annotation counts, and progress tracking

### Security
- CSRF protection (JSON Content-Type enforcement)
- Path traversal prevention (allowed roots whitelist)
- Rate limiting on auth and heavy endpoints
- Input validation and sanitization
- No hardcoded secrets

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Flask, Flask-SocketIO |
| Database | SQLite (WAL mode) |
| Frontend | Vanilla JS, HTML Canvas |
| ML | Ultralytics YOLO (v8/v11) |
| Auth | Session-based with bcrypt hashing |

## Project Structure

```
annotation-app/
├── app.py              # App factory & entrypoint
├── config.py           # Configuration & constants
├── database.py         # SQLite connection & schema
├── auth.py             # Authentication helpers
├── state.py            # Per-room state management
├── extensions.py       # Flask extensions (SocketIO, CORS)
├── rate_limit.py       # Sliding-window rate limiter
├── models/             # YOLO model weights (.pt)
├── routes/
│   ├── auth_routes.py        # Login, register, user info
│   ├── room_routes.py        # Room CRUD, join, privacy
│   ├── folder_routes.py      # File/folder browsing
│   ├── image_routes.py       # Image listing, labels CRUD
│   ├── inference_routes.py   # YOLO inference & auto-annotate
│   ├── training_routes.py    # Model training management
│   ├── export_routes.py      # Dataset export
│   ├── class_routes.py       # Annotation class management
│   ├── batch_routes.py       # Batch operations
│   ├── chat_routes.py        # In-room messaging
│   ├── stats_routes.py       # Dataset statistics
│   ├── assignment_routes.py  # Image assignment
│   └── edit_routes.py        # Edit tracking
├── services/
│   ├── image_service.py      # Image indexing & caching
│   ├── label_service.py      # Label read/write (bbox + polygon)
│   ├── export_service.py     # YOLO/COCO/VOC export
│   └── training_service.py   # Training script generation
├── sockets/
│   └── events.py             # WebSocket event handlers
├── static/
│   ├── css/styles.css        # Application styles
│   └── js/app.js             # Frontend SPA (~3000 lines)
└── templates/
    ├── base.html
    ├── index.html
    └── partials/
        ├── annotator.html    # Annotation workspace
        ├── auth.html         # Login/register forms
        ├── chat.html         # Chat panel
        ├── modals.html       # All modal dialogs
        └── rooms.html        # Room list & creation
```

## Setup

### Prerequisites
- Python 3.12+
- pip

### Installation

```bash
# Clone the repository
git clone https://github.com/ryasrk/AnnotatorAPP.git
cd AnnotatorAPP

# Create virtual environment
python3 -m venv env
source env/bin/activate

# Install dependencies
pip install flask flask-socketio flask-cors bcrypt ultralytics
```

### Running

```bash
# Development
python app.py

# Production (systemd)
sudo systemctl start nexus-annotator.service
```

The app runs on `http://172.20.10.10:5000` by default. Configure via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `172.20.10.10` | Server bind address |
| `PORT` | `5000` | Server port |
| `SECRET_KEY` | random | Flask secret key |
| `CORS_ORIGINS` | `*` | Allowed CORS origins |
| `ALLOWED_ROOT_1` | — | Additional allowed browse path |
| `ALLOWED_ROOT_2` | — | Additional allowed browse path |

## Usage

1. **Register/Login** — Create an account or log in
2. **Create a Room** — Set room name, code, and privacy (public/private)
3. **Open Folder** — Browse to your images directory (and optionally a separate labels directory)
4. **Annotate** — Draw bounding boxes (`B`) or polygons (`G`) on images
5. **Auto-Annotate** — Use a YOLO model to generate predictions, filter by class, then accept results
6. **Export** — Export dataset in YOLO, COCO, or Pascal VOC format
7. **Train** — Launch YOLO training with custom hyperparameters directly from the app

## Label Format

### Bounding Box (YOLO)
```
class_id center_x center_y width height
```

### Polygon Segmentation (YOLO)
```
class_id x1 y1 x2 y2 x3 y3 ... xn yn
```

All coordinates are normalized (0–1).

## License

MIT
