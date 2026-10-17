# SprayWall SAM refinement service.
# Point-prompted Segment Anything that turns Roboflow hold centers into full masks.
# Contract (called by the backend's refineWithSam):
#   POST /refine  { "image": "<base64 jpeg>", "points": [[x, y], ...] }   # pixel coords
#   -> { "polygons": [ {"points": [{"x": .., "y": ..}, ...]} | null, ... ] }  # aligned to points
import base64, io
import numpy as np
import cv2
from fastapi import FastAPI
from pydantic import BaseModel
from PIL import Image
from ultralytics.models.sam import Predictor as SAMPredictor

app = FastAPI()
_predictor = None


def get_predictor():
    global _predictor
    if _predictor is None:
        _predictor = SAMPredictor(overrides=dict(
            task="segment", mode="predict", imgsz=1024,
            model="mobile_sam.pt", save=False, verbose=False,
        ))
    return _predictor


class RefineReq(BaseModel):
    image: str                 # base64 jpeg (no data: prefix)
    points: list[list[float]]  # [[x, y], ...] in pixel coords


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/refine")
def refine(req: RefineReq):
    arr = np.array(Image.open(io.BytesIO(base64.b64decode(req.image))).convert("RGB"))
    predictor = get_predictor()
    predictor.set_image(arr)          # encode the image once
    H, W = arr.shape[:2]
    polygons = []
    for (px, py) in req.points:        # one cheap prompt per hold
        try:
            r = predictor(points=[[px, py]], labels=[1])
            m = r[0].masks.data[0].cpu().numpy().astype("uint8")
            if m.shape[:2] != (H, W):
                m = cv2.resize(m, (W, H), interpolation=cv2.INTER_NEAREST)
            cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cnts:
                polygons.append(None)
                continue
            c = max(cnts, key=cv2.contourArea).reshape(-1, 2)
            step = max(1, len(c) // 40)   # ~40 points is plenty
            polygons.append({"points": [{"x": float(x), "y": float(y)} for x, y in c[::step]]})
        except Exception:
            polygons.append(None)
    return {"polygons": polygons}
