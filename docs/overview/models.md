# Model environments and provenance

Real GPU smoke tests now pass on the Runpod A40 for MOSS native streaming, FastLLVE, YOLO/ByteTrack, RelayVSR, ReLift's DA3/AllTracker path, and BVI-Mamba. Exact installed revisions, checkpoint identities and measured results are recorded in `model-lock.json` and `docs/overview/deployment.md`. Staged incident accuracy is not established by these tests.

## MOSS-VL-Realtime NF4

Official source: https://github.com/OpenMOSS/MOSS-VL ; official streaming protocol: `inference/realtime/README.md`. Source pinned in `model-lock.json`.

Linux NVIDIA GPU, 24 GB minimum for the upstream quantized recipe; deployed on a 48 GB A40. `bash scripts/setup_gpu.sh` installs a separate Python 3.12 environment and snapshots `OpenMOSS-Team/MOSS-VL-Realtime-NF4` to `weights/moss-nf4`, recording the resolved Hugging Face commit. The deployed environment uses the matching official FlashAttention 2.8.1 wheel and has passed native inference.

Set these locally (absolute paths recommended):

```dotenv
STREAMING_MODEL=moss
MOSS_WS_URL=ws://127.0.0.1:18001/v1/realtime
MOSS_SERVICE_COMMAND='["/opt/safesc/third_party/MOSS-VL/.venv/bin/python","/opt/safesc/third_party/MOSS-VL/inference/realtime/run_online_inference.py","--serve","--host","127.0.0.1","--port","18001","--checkpoint","/opt/safesc/weights/moss-nf4","--attention-backend","flash_attention_2"]'
```

Set `MODEL_REVISION` to the recorded weights SHA. Alternatively run the same command manually and leave `MOSS_SERVICE_COMMAND` empty. The managed process loads on demand and stays warm between sources and exits before heavyweight jobs or API shutdown. Phone ACKs are independent of model startup; the bounded inference queue reports waiting/loading and skipped samples. Upload replay warms dependencies before advancing the media clock. Use the authenticated `POST /api/models/moss/warm` before a live demonstration.

The Runpod base image reserves port 8001 for its proxy; the deployed model uses loopback port **18001**, and the authenticated public API uses **8000**. The matching official FlashAttention 2.8.1 cp312/torch2.8/cu12/CXX11-ABI wheel is installed. Do not install a second runtime quantization configuration over the released NF4/HQQ model settings.

Per-frame user prompts interrupt MOSS's native decoder and can truncate a structured response. The adapter instead adds a source index/time margin and anonymous track boxes to analysis-only images. Stored original and enhanced media do not contain that metadata margin. Strict JSON/schema validation remains mandatory; malformed output is never silently repaired into evidence.

The official MOSS service supports one session and remains loopback-only. Its native observer preserves incremental frames and silence/response behavior. **Native MOSS JSON experiments failed strict schema checks**; the deployed path does not treat its narrative as a structured incident verdict. Narrative is stored as untrusted context and passed with original evidence frames to a separate pinned **Qwen3-VL-4B-Instruct** visual verifier. `lm-format-enforcer==0.11.3` constrains JSON keys, enums, and actual source frame IDs; Pydantic and explicit frame/time checks reject unsupported outputs before temporal agreement gating. Scores are uncalibrated, and no positive incident accuracy benchmark has passed yet.

Qwen source weights: `Qwen/Qwen3-VL-4B-Instruct` revision `ebb281ec70b05090aa6165b016eac8ec08e71b17`, Apache-2.0. It runs in the Python 3.11 control environment with Transformers 4.57.1 and SDPA. The first real benign-frame verification took 8.51 seconds excluding initial model loading. The model remains resident with MOSS between sources, and both release memory before isolated postprocessors. Setup: `bash scripts/setup_runpod_models.sh verifier`. The observer and verifier are inference roles; neither trains itself from reviewer feedback.

## FastLLVE

The optional reviewed-learning adapter uses PEFT 0.17.1, installed by the verifier setup stage. `VERIFIER_ADAPTER` selects a local artifact with matching base revision and recorded hashes. A failed automatic gate additionally requires `VERIFIER_RESEARCH_MODE=true` and an explicit hash-bound owner approval file; it is visibly labeled research mode. See [the learning experiment](learning.md). Leave the adapter setting empty to use the base verifier.

## FastLLVE setup

Official source: https://github.com/Wenhao-Li-777/FastLLVE (Apache-2.0).

Upstream uses a custom IA-LUT CUDA extension and an old PyTorch stack. The published constructor references a missing `backbone_name` field; the compatibility patch below preserves the existing initialization branch. Validate output against the authors' implementation before using evaluation scores.

On Linux/CUDA, after fetching the pinned source:

```bash
uv pip install torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
git -C third_party/FastLLVE apply ../../patches/fastllve-constructor.patch
uv run python third_party/FastLLVE/models/IALUT/IALUT_transform/setup.py install
```

CUDA compiler (`nvcc`), GCC and Ninja must be installed. The extension setup expects the repository extension directory as its working directory; if source paths fail, run the setup from `third_party/FastLLVE/models/IALUT/IALUT_transform` with the project's Python executable.

Download `FastLLVE_outdoor.pth` from the official Google Drive folder linked in the upstream README: https://drive.google.com/drive/folders/1AGgjfo6zriGJkZYLLBT6j55F4vNkdjWO . This release is not an authenticated Hugging Face snapshot and may require a manual download. Store under `weights/`, record SHA-256 in `model-lock.json`, and set:

```dotenv
ENHANCEMENT_MODEL=fastllve
FASTLLVE_CHECKPOINT=/opt/safesc/weights/FastLLVE_outdoor.pth
```

The adapter runs the official network on a trailing seven-frame context, maps output back to the source dimensions, and returns its latest frame. Moderate darkness blends 50/50; severe darkness uses full enhancement. It does not claim to recover missing physical details. Current live enhancement operates at inference sample rate; the saved original retains all received frames. Full-frame enhanced output is not yet implemented.

## Tracking

```bash
uv sync --extra tracking
```

Set `ENABLE_TRACKING=true`. Ultralytics YOLO11n supplies person boxes; Supervision ByteTrack assigns temporary numeric track labels. Person boxes never establish identity. Record the downloaded detector checkpoint hash before a deployment. Ultralytics licensing must be evaluated for campus redistribution (AGPL/enterprise); ByteTrack and other dependencies retain separate licenses.

## RelayVSR

Official source: https://github.com/kopperx/RelayVSR (Apache-2.0; upstream notices retained).

```bash
uv run python scripts/models.py relayvsr --weights
cd third_party/RelayVSR
uv sync --locked --extra cu128
```

Set `ENABLE_RELAY_VSR=true`. Jobs run that environment's `inference.py` on the extracted original window, then render a separate labeled copy. The worker records runtime and hashes. The default 4x output can be expensive; benchmark on short incident windows before extending duration. No L40S throughput has been measured.

## ReLift

Official source: https://github.com/ReLift3D/ReLift (MIT code; several front ends/checkpoints are non-commercial).

```bash
uv run python scripts/models.py relift
cd third_party/ReLift
bash scripts/setup.sh
conda activate relift
python scripts/download_weights.py
```

Set `ENABLE_RELIFT=true` and `RELIFT_PYTHON` to its isolated environment executable. The Runpod installation uses a Python 3.10 uv environment populated with the exact upstream `environment.yml` pip requirements; it does not require conda. Palladium invokes that Python's `scripts/demo_video.py <clip> --out <directory> --num_frames 84`, first on the original, then on the conservative enhanced stream when available. DA3/AllTracker passed the real 84-frame test. Optional CoWTracker/VGGT-Omega checkpoints are not required or installed. Preserve the separate checkpoint licenses from `configs/weights.yaml`.

The real `tracks.npz` is retained, including geometry and camera arrays. Palladium exports up to roughly 250 sampled points per frame for the browser and marks model units as nonmetric. Track-to-person association is not claimed without reliable mapping.

## OneStreamer and BVI-Mamba

OneStreamer interface intentionally raises unavailable while no official checkpoint is configured; use MOSS for real streaming.

BVI-Mamba's official v1.0.0 release contains `BVIMamba_BVI.pth.tar`; it is downloaded and SHA-256 recorded. `ml/bvimamba.py` wraps the official network and five-frame centered context for offline comparison. Its DCN extension compiles through `BASICSR_JIT=True`; the official matching Mamba 2.3.2.post1 CUDA wheel is installed. Real 512×512 inference passes. This adapter is intentionally not resident during live monitoring. When exporting video, align output to the context's center frame and document any resize. `scripts/compare_enhancement.py` can compare aligned exports; the image smoke test is not a quality benchmark.

## License inventory

- Application code: project licensing not selected yet; do not assume redistribution rights for bundled third-party weights.
- MOSS code/checkpoint: verify the exact pinned repository license and model card before redistribution.
- Qwen3-VL-4B-Instruct: Apache-2.0, pinned weights and model card.
- BVI-Mamba: retain the pinned upstream license and checkpoint release notices.
- FastLLVE code: Apache-2.0; preserve the weight-source record separately.
- RelayVSR code: Apache-2.0 with upstream model notices.
- ReLift code: MIT; DA3, VGGT-Omega, CoWTracker and 4RC have separate non-commercial terms.
- Ultralytics person detector: AGPL/enterprise terms; ByteTrack dependency terms separate.

Hugging Face tokens enable downloads; they do not override gated access or model licenses. Do not commit weights or tokens.
