"""
Label read/write operations (YOLO format).
Supports both detection (bbox) and segmentation (polygon) labels.
Detection line: class_id cx cy w h  (5 values)
Segmentation line: class_id x1 y1 x2 y2 ... xn yn  (odd count, >= 7 values)
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
                if len(parts) >= 7 and len(parts) % 2 == 1:
                    # Segmentation: class_id x1 y1 x2 y2 ... xn yn
                    class_id = int(parts[0])
                    points = []
                    for i in range(1, len(parts), 2):
                        points.append([float(parts[i]), float(parts[i + 1])])
                    labels.append({
                        "type": "polygon",
                        "class_id": class_id,
                        "points": points,
                    })
                elif len(parts) >= 5:
                    # Detection: class_id cx cy w h
                    labels.append({
                        "type": "bbox",
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
            if lbl.get("type") == "polygon" and "points" in lbl:
                coords = " ".join(
                    f"{pt[0]:.6f} {pt[1]:.6f}" for pt in lbl["points"]
                )
                f.write(f"{lbl['class_id']} {coords}\n")
            else:
                f.write(f"{lbl['class_id']} {lbl['cx']:.6f} {lbl['cy']:.6f} {lbl['w']:.6f} {lbl['h']:.6f}\n")
