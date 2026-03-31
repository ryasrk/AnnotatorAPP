"""
Label read/write operations (YOLO format).
"""

from pathlib import Path

import state


def read_labels(image_name):
    label_path = state.RAW_LABELS_DIR / f"{Path(image_name).stem}.txt"
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


def write_labels(image_name, labels):
    label_path = state.RAW_LABELS_DIR / f"{Path(image_name).stem}.txt"
    state.RAW_LABELS_DIR.mkdir(parents=True, exist_ok=True)
    with open(label_path, "w") as f:
        for lbl in labels:
            f.write(f"{lbl['class_id']} {lbl['cx']:.6f} {lbl['cy']:.6f} {lbl['w']:.6f} {lbl['h']:.6f}\n")
