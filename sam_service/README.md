# SAM refinement service

Point-prompted Segment Anything that turns Roboflow hold centers into fuller
hold masks. The backend calls this only when `SAM_ENDPOINT_URL` is set.

## Contract
POST /refine
  { "image": "<base64 jpeg>", "points": [[x, y], ...] }   # pixel coords
  -> { "polygons": [ {"points": [{"x": .., "y": ..}, ...]} | null, ... ] }
The response is aligned to the input points; null means SAM found nothing
there and the backend keeps Roboflow's polygon for that hold.

## Run locally
  pip install -r requirements.txt
  uvicorn app:app --host 0.0.0.0 --port 8000
Then set SAM_ENDPOINT_URL=http://<host>:8000/refine in the backend env.

## Deploy
Any scale-to-zero GPU host works (Modal, Replicate, RunPod, HF Spaces).
It only runs during a detect, so a cold GPU that sleeps afterward is ideal.
