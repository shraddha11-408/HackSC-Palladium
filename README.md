# Palladium

**Campus video review with preserved context and a human decision.** Built for the AI@USC hackathon.

Palladium connects a phone camera or uploaded video to a streaming vision pipeline, preserves potentially relevant moments, and gives a reviewer original footage, uncertainty, and clearly labeled derived artifacts. A separate campus-activity map explores public LAPD reports near USC.

[Open the hosted Palladium dashboard](https://safe-sc.replit.app) · Workspace access token required. The UI runs on Replit; inference and working media stay on Runpod. Original incident windows, thumbnails and review metadata are backed up to private Supabase Storage.

## What works today

- Phone capture through an expiring QR pairing link, a native WebRTC dashboard video path targeting 1080p/60 FPS, separate acknowledged evidence frames, and rear/front camera selection. Audio is off. See [streaming setup and measurements](docs/overview/live-video.md).
- MOSS-VL-Realtime NF4 observation with a separate Qwen3-VL-4B visual verifier and strict structured-output validation.
- Lighting assessment, gated FastLLVE enhancement, and temporal incident gating. No YOLO/ByteTrack overlay is enabled in this deployment.
- Preserved original incident windows, SHA-256 hashes, reviewer bookmarks, append-only decisions, and model provenance.
- Serialized RelayVSR review enhancement, ReLift estimated 3D trajectories, and optional BVI-Mamba comparisons.
- Large synchronized review players, an original-clip Qwen review pass, live MOSS scene notes, and a latest-frame WebSocket preview.
- Private Supabase incident archives with verified original hashes, restore support, an 800 MiB cap and FIFO cloud-media eviction. See [storage behavior and retention](docs/overview/storage.md).
- An interactive map of 75,686 grouped LAPD reports from January 2010 through October 2026, with date/category filters and source-linked summaries.
- A precomputed full-UPC-zone seasonal activity outlook, date/time controls, local walking-route comparisons, satellite/aerial context, and ambassador coverage planning. The analysis bundle must be prepared on the data host; [setup, validation, and limitations](docs/overview/activity-forecasting.md). [Pedestrian survey evidence](docs/overview/pedestrian-distribution.md) is displayed separately and is not treated as a validated hourly flow model.
- A reviewed learning repository with original video playback, exact four-frame training inputs, permission history, append-only annotations, immutable dataset versions, and measured model experiments.

The current application supports **one active video source** and a shared reviewer workspace. Two-camera support, separate student accounts, and reviewer-approved student notifications remain planned. A Qwen LoRA research candidate has been trained on 19 approved research windows and evaluated separately; [results and limitations](docs/overview/learning.md) are explicit. Automatic continuous training is not enabled. Activity forecasting is a separately prepared seasonal research outlook with explicit validation limits.

## Architecture

```text
Phone camera / uploaded video
             |
     FastAPI CPU ingestion ---- frame ACK / live telemetry
             |
     Timestamped original buffer
             |
     Lighting -> FastLLVE when dark -> anonymous tracking
             |
     MOSS streaming observer + Qwen visual verifier
             |
     Schema checks + temporal evidence gate
             |
     Original clip + hash + provenance -> human review
             |                                |
     Private Supabase archive          append-only decisions
     (FIFO media cap + restore)               |
             +------ versioned review metadata+
             |
     GPU idle queue: RelayVSR / ReLift / BVI-Mamba

Official LAPD records -> bounded local import -> SQLite
             |
     UPC Lyft-area historical activity map
```

See the [project documentation](docs/overview/README.md) and [full text diagram](docs/architecture.txt).

## Quick start: local development

Requires Python 3.11, Node.js 22, and [uv](https://docs.astral.sh/uv/). The control plane runs on macOS or Linux; real model inference requires Linux and NVIDIA CUDA.

```bash
git clone https://github.com/shraddha11-408/HackSC-Palladium.git
cd HackSC-Palladium
uv sync --python 3.11 --frozen --extra test
npm ci --prefix apps/web
npm run build --prefix apps/web
```

On a fresh checkout, copy `.env.example` to `.env` and enter credentials locally. Never overwrite an existing `.env` containing your own settings. For a clearly labeled fixture demonstration without a GPU:

```bash
uv run python -m scripts.make_demo
STREAMING_MODEL=fixture uv run uvicorn apps.api.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Open [localhost:8000](http://localhost:8000) and enter the generated access token from `data/app_token`. Upload `data/demo-fixture.mp4`. Fixture alerts are visibly simulated; they verify application plumbing, not detection accuracy. Real inference never silently falls back to simulated results.

For the actual GPU stack, follow [model setup and licenses](docs/overview/models.md) and [deployment notes](docs/overview/deployment.md). Checkpoint revisions and measured smoke-test results are recorded in `model-lock.json`. Upstream models use isolated environments; the CPU Docker image is not a validated all-model GPU image.

## 3D command dashboard

`apps/dashboard` is a full-screen 3D view of campus for the dispatcher: live incident beams, approve-and-dispatch arcs, hourly history columns and camera coverage cones. It runs on Google Photorealistic 3D Tiles when a key is set, and otherwise on a free MapLibre fallback.

The hosted workspace opens the **Command center** after sign-in and loads incidents with the existing session. The sidebar also gives reviewers access to the overview and other workspace views. The [Replit hosting guide](docs/overview/replit.md) covers building and publishing the command view and officer links.

```bash
cd apps/dashboard && npm install && npm run dev   # http://localhost:5174
```

Every layer is labelled Real, Demo, Simulated or Estimate. Camera positions and officers are simulated. See [apps/dashboard/README.md](apps/dashboard/README.md).

## Connect a phone

To host the dashboard and phone capture page on Replit while keeping inference on Runpod, use the checked-in `.replit` configuration and [Replit hosting instructions](docs/overview/replit.md). Only the public backend origin belongs in Replit configuration; provider tokens stay on their existing machines.

1. Serve the application through HTTPS and set `PUBLIC_URL` to that origin.
2. Sign in to the reviewer workspace and select **Connect phone**.
3. Scan the QR code, open the link in Safari or Chrome, allow camera access, and tap **Start camera**.
4. Keep the capture page foregrounded. The acknowledged-frame counter confirms receipt.

Transport is timestamped JPEG over WebSockets. Low-latency capture targets up to 12 FPS at a 960px long edge; detail mode targets up to 8 FPS at 1280px. Inference sampling and actual processing rates differ. Waiting, skipped samples, and model errors remain visible. The user has reported successful physical-device stream telemetry; reproducible engineering measurements are documented separately.

## Download historical activity

```bash
uv run python scripts/data/download_activity.py
```

The importer requests selected non-demographic LAPD fields near USC, filters the published UPC Lyft boundary approximation, and writes compressed source pages plus a normalized SQLite snapshot under ignored `data/activity/`. The map database is approximately 22 MB. A versioned, losslessly compressed copy of the complete minimized public activity snapshot and prepared analysis is included in [public-data/activity](public-data/activity/README.md). Restore it with `python3 -m scripts.data.activity_snapshot restore`. Private source video and the application/incident database remain excluded.

The map shows reported history, not personal risk or a forecast. Locations and the digitized service boundary are approximate. See [data methodology and coverage](docs/overview/activity-data.md).

The separate Forecast & walking routes view uses a prepared seasonal count-model
bundle. Run `python -m scripts.data.download_forecast_streets`,
`python -m scripts.data.prepare_pedestrian_evidence`, then
`python -m scripts.build_activity_forecast` on the data host. Forecasts and
ambassador scenarios are precomputed; route comparisons run in the browser.
Imagery basemap tiles load online. Outputs describe report activity and planning
scenarios, not a probability of personal harm or actual DPS assignments.

## Verification

```bash
uv run pytest -q
npm run build --prefix apps/web
uv run python -m scripts.evaluate --annotations evaluation/example.json --predictions evaluation/predictions.example.json
python3 scripts/check_secrets.py --tracked
```

Forty-eight CPU/API/protocol/learning/storage tests, five gateway checks and the production frontend build passed in the November 14 engineering verification. Real GPU smoke tests passed for the installed models. The automatic phone-protocol replay produced contact and object-taking reports, preserved the annotated activity in their originals, and displayed red chat notices without a human bookmark. It also falsely flagged one of two ordinary diagnostic videos; measured notice lag was about 27–37 seconds from cited evidence. These are reused research clips, not independent safety validation. Two further training runs were weaker and were not activated. See [training results](evaluation/event-training-followup.json) and [live diagnostic results](evaluation/event-live-diagnostic.json).

An earlier 80-second test through Replit with real models and a static public image delivered 237 preview frames (2.96 FPS), with 491 ms median sender-to-preview time and 1,450 ms p95. This measures protocol receipt, not physical camera-to-browser paint latency or event-detection accuracy. The separate original-clip Qwen pass took 43.18 seconds including startup on the A40. See [review measurements and limitations](docs/overview/review-workflow.md).

`evaluation/example.json` and `evaluation/predictions.example.json` are synthetic schema examples. The learning-pilot ledger and results contain actual research-experiment records. Production event recall, false-negative rates, and multi-camera capacity still require representative evaluation; smoke tests and the tiny prelocalized research pilot do not establish safety performance.

## Repository hygiene and limitations

- `.env`, API tokens, SSH keys, access links, cloud-account notes, videos, databases, downloaded weights, and generated output stay local and are ignored.
- `.env.example` contains empty credential placeholders. Compute-provider administration tokens stay on the development machine. Required model-download access and the private Supabase archive key belong only on the backend worker; none are bundled into the UI.
- Run `python3 scripts/check_secrets.py` after staging changes. The check rejects credential files, known local secret values, and common token/private-key patterns without printing their values.
- Original uploads are hashed; extracted windows and enhanced outputs have separate provenance. Generated detail and estimated 3D geometry are not authoritative evidence.
- No identity recognition, demographic inference, or automatic external dispatch is implemented. Reviewer scores are uncalibrated.
- Open-weight dependencies have separate code/checkpoint licenses, including non-commercial restrictions and Ultralytics licensing considerations. Download access does not grant redistribution rights.
