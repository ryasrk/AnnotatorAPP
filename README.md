# Nexus Annotator

Multi-user YOLO annotation and training platform built with Flask, SocketIO, and vanilla JavaScript.

![Python](https://img.shields.io/badge/Python-3.12-blue)
![Flask](https://img.shields.io/badge/Flask-SocketIO-green)
![YOLO](https://img.shields.io/badge/Ultralytics-YOLO-purple)

## Features

### Annotation
- **Bounding Box** — Click-and-drag rectangle annotation
- **Polygon Segmentation** — Multi-point polygon annotation with vertex editing (add/delete/drag vertices)
- **Auto-Annotate** — Run YOLO inference on all images with class filtering, confidence/IoU thresholds, and batch accept/reject (supports both detection and segmentation models)
- **Inference Preview** — Run single-image inference with adjustable confidence, visualize detections on canvas, then accept or clear
- **Model Browser** — Browse and select `.pt` model files from allowed directories; shared model list between inference and auto-annotate
- **Batch Operations** — Multi-select images with checkboxes for bulk delete, relabel, or reassign
- **Undo/Redo** — `Ctrl+Z` undo support for annotations
- **Keyboard Shortcuts** — `B` Draw, `G` Polygon, `V` Select, `Del` Delete, `A/D` Navigate, `Ctrl+S` Save

### Model Management
- **Validation Dashboard** — Run YOLO validation with per-class metrics (mAP50, mAP50-95, precision, recall), confusion matrix, and clickable training plots
- **Model Export** — Export models to 17 formats: ONNX, TorchScript, OpenVINO, TensorRT, CoreML, SavedModel, TFLite, PB, EdgeTPU, TF.js, PaddlePaddle, MNN, NCNN, IMX, RKNN, ExecuTorch, Axelera — with format-specific options (FP16, dynamic axes, ONNX simplify)
- **Model Benchmark** — Compare inference speed across export formats with background execution
- **Dataset Split** — Split dataset into train/val/test sets with configurable ratios

### Collaboration
- **Multi-User Rooms** — Create/join rooms with unique codes
- **Private/Public Rooms** — Private rooms require owner approval to join
- **Real-Time Sync** — WebSocket-based live updates for labels, assignments, and chat
- **Online Presence** — Green ring indicators on member avatars; text-based connection status
- **In-App Chat** — Room-scoped messaging with sound notifications and online member highlighting
- **Image Assignment** — Assign images to specific annotators with ratio-based distribution and colored badge chips
- **Editor Tracking** — See who last edited each image with color-coded indicators

### Training & Export
- **YOLO Training** — Launch model training directly from the app with configurable hyperparameters (learning rate, loss weights, augmentation)
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
│   ├── helpers.py            # Shared route utilities (error handler)
│   ├── auth_routes.py        # Login, register, user info
│   ├── room_routes.py        # Room CRUD, join, privacy
│   ├── folder_routes.py      # File/folder browsing
│   ├── image_routes.py       # Image listing, labels CRUD
│   ├── inference_routes.py   # YOLO inference & auto-annotate
│   ├── model_routes.py       # Validate, export, benchmark, split
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
│   └── js/
│       ├── state.js          # Global state & constants (48 lines)
│       ├── api.js            # Unified API client (apiGet/apiPost/apiDelete)
│       ├── utils.js          # Shared utilities (toast, modals, undo)
│       ├── socket.js         # WebSocket initialization & events
│       ├── auth.js           # Authentication & room management
│       ├── training.js       # Training view, GPU, sessions, charts
│       ├── chat.js           # Chat, notifications, remote cursors
│       ├── models.js         # Model validate/export/benchmark & inference
│       ├── canvas.js         # Canvas rendering, polygon, mouse/keyboard
│       └── app.js            # Dashboard, batch, assignments, init
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

The app runs on `http://localhost:5000` by default. Configure via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `0.0.0.0` | Server bind address |
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
