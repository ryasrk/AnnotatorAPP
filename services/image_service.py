"""
Image indexing, caching, and annotation info.
"""

import threading
from pathlib import Path

from config import IMAGE_EXTENSIONS
import state


def index_images():
    if state.RAW_IMAGES_DIR.is_dir():
        state.image_names = sorted(
            f.name for f in state.RAW_IMAGES_DIR.iterdir()
            if f.suffix.lower() in IMAGE_EXTENSIONS
        )
    else:
        state.image_names = []
    print(f"[INDEX] {len(state.image_names)} images")


def build_cache():
    cache = {}
    class_dist = {}
    for name in state.image_names:
        label_path = state.RAW_LABELS_DIR / (Path(name).stem + ".txt")
        bbox_count = 0
        if label_path.exists():
            with open(label_path) as f:
                for line in f:
                    parts = line.strip().split()
                    if len(parts) >= 5:
                        bbox_count += 1
                        cls_id = parts[0]
                        class_dist[cls_id] = class_dist.get(cls_id, 0) + 1
        cache[name] = {"annotated": bbox_count > 0, "bbox_count": bbox_count}
    with state.state_lock:
        state.image_cache.clear()
        state.image_cache.update(cache)
        state.cache_ready = True
        state._class_distribution = class_dist
    print(f"[CACHE] {sum(1 for v in cache.values() if v['annotated'])} annotated")


def get_annotation_info(image_name):
    with state.state_lock:
        if image_name in state.image_cache:
            return state.image_cache[image_name]
    label_path = state.RAW_LABELS_DIR / (Path(image_name).stem + ".txt")
    bbox_count = 0
    if label_path.exists():
        with open(label_path) as f:
            bbox_count = sum(1 for line in f if line.strip())
    info = {"annotated": bbox_count > 0, "bbox_count": bbox_count}
    with state.state_lock:
        state.image_cache[image_name] = info
    return info


def reload_dataset():
    with state.state_lock:
        state.image_cache.clear()
        state.cache_ready = False
    index_images()
    threading.Thread(target=build_cache, daemon=True).start()
