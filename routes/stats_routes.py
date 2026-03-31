"""
Stats, dashboard, and quality metrics routes.
"""

from pathlib import Path

from flask import Blueprint, jsonify, request, session

from auth import login_required
from database import get_db
from services.label_service import read_labels
import state

bp = Blueprint("stats_routes", __name__)


@bp.route("/api/stats")
def api_stats():
    with state.state_lock:
        ready = state.cache_ready

    if not ready:
        return jsonify({
            "total_images": len(state.image_names),
            "annotated": -1, "unannotated": -1, "total_bboxes": -1,
            "class_names": state.CLASS_NAMES, "cache_ready": False,
        })

    with state.state_lock:
        cache = dict(state.image_cache)

    annotated = sum(1 for v in cache.values() if v["annotated"])
    total_bboxes = sum(v["bbox_count"] for v in cache.values())
    class_dist = {}
    for name in state.image_names:
        labels = read_labels(name)
        for lbl in labels:
            cid = str(lbl["class_id"])
            class_dist[cid] = class_dist.get(cid, 0) + 1

    return jsonify({
        "total_images": len(state.image_names),
        "annotated": annotated,
        "unannotated": len(state.image_names) - annotated,
        "total_bboxes": total_bboxes,
        "class_names": state.CLASS_NAMES,
        "class_distribution": class_dist,
        "cache_ready": True,
    })


@bp.route("/api/dashboard-stats")
@login_required
def api_dashboard_stats():
    room_id = request.args.get("room_id") or session.get("room_id") or state.CURRENT_ROOM_ID
    if not room_id:
        return jsonify({"member_stats": []})

    db = get_db()
    stats = db.execute("""
        SELECT u.id, u.username, u.display_name, u.color,
               COUNT(ie.id) AS edit_count
        FROM users u
        JOIN room_members rm ON rm.user_id = u.id
        LEFT JOIN image_edits ie ON ie.user_id = u.id AND ie.room_id = ?
        WHERE rm.room_id = ?
        GROUP BY u.id
        ORDER BY edit_count DESC
    """, (room_id, room_id)).fetchall()
    db.close()
    return jsonify({"member_stats": [dict(s) for s in stats]})


@bp.route("/api/quality-metrics")
@login_required
def api_quality_metrics():
    total_images = len(state.image_names)
    annotated = 0
    total_boxes = 0
    class_counts = {}
    box_counts = []
    tiny_boxes = 0
    huge_boxes = 0

    for name in state.image_names:
        stem = Path(name).stem
        label_path = state.RAW_LABELS_DIR / f"{stem}.txt"
        if label_path.exists():
            text = label_path.read_text().strip()
            if text:
                lines = text.split("\n")
                num_boxes = len(lines)
                annotated += 1
                total_boxes += num_boxes
                box_counts.append(num_boxes)
                for line in lines:
                    parts = line.strip().split()
                    if len(parts) >= 5:
                        cls_id = parts[0]
                        class_counts[cls_id] = class_counts.get(cls_id, 0) + 1
                        w, h = float(parts[3]), float(parts[4])
                        area = w * h
                        if area < 0.001:
                            tiny_boxes += 1
                        elif area > 0.5:
                            huge_boxes += 1
            else:
                box_counts.append(0)
        else:
            box_counts.append(0)

    avg_boxes = round(total_boxes / annotated, 1) if annotated else 0
    max_boxes = max(box_counts) if box_counts else 0

    if class_counts:
        vals = list(class_counts.values())
        mean_c = sum(vals) / len(vals)
        variance = sum((v - mean_c) ** 2 for v in vals) / len(vals)
        class_balance_score = round(1.0 - min(1.0, (variance ** 0.5) / (mean_c + 1)), 2)
    else:
        class_balance_score = 0

    return jsonify({
        "total_images": total_images,
        "annotated_images": annotated,
        "unannotated_images": total_images - annotated,
        "total_boxes": total_boxes,
        "avg_boxes_per_image": avg_boxes,
        "max_boxes": max_boxes,
        "class_distribution": class_counts,
        "class_balance_score": class_balance_score,
        "tiny_boxes": tiny_boxes,
        "huge_boxes": huge_boxes,
        "annotation_coverage": round(annotated / total_images * 100, 1) if total_images else 0,
    })
