"""
Dataset export in YOLO, COCO, and VOC formats.
"""

import json
import shutil
from pathlib import Path

import state
from services.label_service import read_labels


def export_yolo(target_dir, train_imgs, valid_imgs):
    train_img_dir = target_dir / "train" / "images"
    train_lbl_dir = target_dir / "train" / "labels"
    valid_img_dir = target_dir / "valid" / "images"
    valid_lbl_dir = target_dir / "valid" / "labels"

    for d in [train_img_dir, train_lbl_dir, valid_img_dir, valid_lbl_dir]:
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

    def copy_split(img_list, img_dir, lbl_dir):
        for img_name in img_list:
            src_img = state.RAW_IMAGES_DIR / img_name
            src_lbl = state.RAW_LABELS_DIR / f"{Path(img_name).stem}.txt"
            if src_img.exists():
                shutil.copy2(str(src_img), str(img_dir / img_name))
            if src_lbl.exists():
                shutil.copy2(str(src_lbl), str(lbl_dir / (Path(img_name).stem + ".txt")))

    copy_split(train_imgs, train_img_dir, train_lbl_dir)
    copy_split(valid_imgs, valid_img_dir, valid_lbl_dir)

    data_yaml = target_dir / "data.yaml"
    with open(data_yaml, "w") as f:
        f.write("train: ../train/images\n")
        f.write("val: ../valid/images\n\n")
        f.write(f"nc: {len(state.CLASS_NAMES)}\n")
        f.write(f"names: {state.CLASS_NAMES}\n")

    return {
        "status": "exported", "format": "yolo",
        "train_count": len(train_imgs),
        "valid_count": len(valid_imgs),
        "export_dir": str(target_dir),
    }


def export_coco(target_dir, train_imgs, valid_imgs):
    from PIL import Image as PILImage

    def build_coco(img_list, split_name):
        out_img_dir = target_dir / split_name / "images"
        out_img_dir.mkdir(parents=True, exist_ok=True)
        coco = {
            "images": [], "annotations": [], "categories": [
                {"id": i, "name": n} for i, n in enumerate(state.CLASS_NAMES)
            ]
        }
        ann_id = 1
        for img_id, img_name in enumerate(img_list, 1):
            src_img = state.RAW_IMAGES_DIR / img_name
            if not src_img.exists():
                continue
            shutil.copy2(str(src_img), str(out_img_dir / img_name))
            try:
                with PILImage.open(src_img) as pil_img:
                    w, h = pil_img.size
            except Exception:
                w, h = 640, 640
            coco["images"].append({"id": img_id, "file_name": img_name, "width": w, "height": h})
            for lbl in read_labels(img_name):
                bw = lbl["w"] * w
                bh = lbl["h"] * h
                bx = (lbl["cx"] - lbl["w"] / 2) * w
                by = (lbl["cy"] - lbl["h"] / 2) * h
                coco["annotations"].append({
                    "id": ann_id, "image_id": img_id, "category_id": lbl["class_id"],
                    "bbox": [round(bx, 2), round(by, 2), round(bw, 2), round(bh, 2)],
                    "area": round(bw * bh, 2), "iscrowd": 0,
                })
                ann_id += 1
        out_json = target_dir / split_name / f"{split_name}.json"
        with open(out_json, "w") as f:
            json.dump(coco, f, indent=2)

    build_coco(train_imgs, "train")
    build_coco(valid_imgs, "valid")

    return {
        "status": "exported", "format": "coco",
        "train_count": len(train_imgs),
        "valid_count": len(valid_imgs),
        "export_dir": str(target_dir),
    }


def export_voc(target_dir, train_imgs, valid_imgs):
    from PIL import Image as PILImage

    def write_voc_xml(img_name, labels, img_w, img_h, out_dir):
        stem = Path(img_name).stem
        xml = f'<annotation>\n  <filename>{img_name}</filename>\n'
        xml += f'  <size><width>{img_w}</width><height>{img_h}</height><depth>3</depth></size>\n'
        for lbl in labels:
            cls_name = state.CLASS_NAMES[lbl["class_id"]] if lbl["class_id"] < len(state.CLASS_NAMES) else f"class_{lbl['class_id']}"
            xmin = max(0, int((lbl["cx"] - lbl["w"] / 2) * img_w))
            ymin = max(0, int((lbl["cy"] - lbl["h"] / 2) * img_h))
            xmax = min(img_w, int((lbl["cx"] + lbl["w"] / 2) * img_w))
            ymax = min(img_h, int((lbl["cy"] + lbl["h"] / 2) * img_h))
            xml += f'  <object>\n    <name>{cls_name}</name>\n    <bndbox>\n'
            xml += f'      <xmin>{xmin}</xmin><ymin>{ymin}</ymin><xmax>{xmax}</xmax><ymax>{ymax}</ymax>\n'
            xml += f'    </bndbox>\n  </object>\n'
        xml += '</annotation>'
        with open(out_dir / f"{stem}.xml", "w") as f:
            f.write(xml)

    def do_export_split(img_list, split_name):
        img_dir = target_dir / split_name / "images"
        ann_dir = target_dir / split_name / "annotations"
        img_dir.mkdir(parents=True, exist_ok=True)
        ann_dir.mkdir(parents=True, exist_ok=True)
        for img_name in img_list:
            src_img = state.RAW_IMAGES_DIR / img_name
            if not src_img.exists():
                continue
            shutil.copy2(str(src_img), str(img_dir / img_name))
            try:
                with PILImage.open(src_img) as pil_img:
                    w, h = pil_img.size
            except Exception:
                w, h = 640, 640
            labels = read_labels(img_name)
            write_voc_xml(img_name, labels, w, h, ann_dir)

    do_export_split(train_imgs, "train")
    do_export_split(valid_imgs, "valid")

    return {
        "status": "exported", "format": "voc",
        "train_count": len(train_imgs),
        "valid_count": len(valid_imgs),
        "export_dir": str(target_dir),
    }
