# Host the UI on Replit

Replit runs a small Node 22 gateway and the built React UI. Runpod remains the sole inference backend and authoritative store. Do not install Python, CUDA, model weights, or video datasets on Replit.

```text
Laptop dashboard                 Phone Safari / Chrome
       |                                  |
       +------------- HTTPS --------------+
                         |
               Replit UI + Node gateway
                |                |
          React static files     +-- /api/* and /ws/* (streamed proxy)
                                         |
                                 Runpod HTTPS proxy
                                         |
                            FastAPI / original video / SQLite
                                         |
                              GPU queue: MOSS + verifier
                             FastLLVE / RelayVSR / ReLift
```

## Import and publish

1. Import `https://github.com/shraddha11-408/HackSC-Palladium` into Replit and keep the **main** branch. It contains the Node gateway, both React apps and the backend source; Replit only builds and runs the gateway and UI (see the scanner note below if publishing is blocked).
2. In Replit Secrets set **only** `PALLADIUM_BACKEND_ORIGIN` to the current GPU app origin, for example `https://YOUR-POD-ID-8000.proxy.runpod.net`. It is an address, not a provider key. The current origin is recorded locally in `data/runpod-access.txt`.
3. Click Run. The configured command builds the UI and binds the gateway to `0.0.0.0:3000`. Check the preview shows the Palladium sign-in screen. (`SAFESC_BACKEND_ORIGIN` is still accepted as a fallback.)
4. Open Publishing → Adjust settings. Choose **Reserved VM**, web server, smallest available machine for a single-phone demo. Set build to `npm run build`, run to `npm start`, local port `3000` / external port `80`. Confirm `PALLADIUM_BACKEND_ORIGIN` is also present in the published environment.
5. Check the displayed publishing charge against the trial's remaining credits before publishing. The trial is not a guarantee of unlimited deployment or video bandwidth. Replit's November 14 pricing documentation lists the shared 0.5 vCPU / 2 GB VM at $15/month before credits. Autoscale can serve the dashboard, but Reserved VM avoids scale-to-zero interruptions for long-lived phone WebSockets. Static hosting cannot run this proxy.
6. Publish, open the HTTPS `.replit.app` URL, and enter the existing Palladium workspace token. No additional reviewer token is configured in Replit. The login cookie belongs to the Replit app origin; the gateway forwards it to the existing authenticated backend.
7. Click Connect phone **on the published Replit dashboard**, scan the new QR code and start the camera. Pairing links use the dashboard's current origin automatically, so both the phone capture page and its WebSocket use Replit. Keep the phone page foregrounded. Existing links from the Runpod dashboard still point at Runpod.
8. The **Command center** opens after sign-in and connects with the existing reviewer session. Officer pairing links open under `/command/` and relay messages through `/ws/dispatch/{room}`. Use a Runpod backend built from the same source revision to enable dispatch recommendations, approval auditing and the phone relay. Configure `ANTHROPIC_API_KEY` on Runpod if you want Claude recommendations. The command view uses simulated units.

The GitHub import does not include `.env`, original clips, local databases, model weights, or cloud keys. Do not paste `RUNPOD_TOKEN`, `VULTR_API_KEY`, `HF_TOKEN`, SSH keys, or the Mac's entire `.env` into Replit. No `VITE_` secret is needed. The gateway never bypasses backend authorization, logs request bodies/tokens, or stores video; uploads, playback range responses, WebSocket bytes and cookies pass through it.

The public historical activity snapshot is versioned on the full **main** branch
under `public-data/activity/`, separately from private operational data. Restore
it on the backend with `python3 -m scripts.data.activity_snapshot restore`. The
Replit deployment branch excludes this data: its gateway serves the authenticated
preloaded analysis from Runpod. Updating the activity feature requires both the
backend's `/api/activity/exploration-bundle` endpoint and the new Replit UI.

Both Runpod and Replit process traffic when this route is used. If the GPU pod stops or its origin changes, the UI still loads, but API/video operations fail until the pod is available or `PALLADIUM_BACKEND_ORIGIN` is updated and the deployment restarted. Replit hosting does not extend the Runpod budget or its Sunday shutdown deadline.

## Update the deployment branch

From the complete application checkout, commit the desired source changes and run `python3 scripts/export_replit.py`, inspect `git ls-tree -r --name-only replit-ui`, then push `git push origin replit-ui`. Fetch that branch in Replit and merge `origin/replit-ui`, then republish. Replit can create local publishing commits, so a later fast-forward-only pull may fail; preserve those settings rather than resetting them. The exporter reads committed Git blobs from an explicit UI allowlist, records the source commit in `DEPLOYMENT_SOURCE.txt`, and keeps the current checkout unchanged. It does not export `.env`, local video, Python dependency manifests or model weights. Never merge this deployment-only tree into the full application branch.

The export includes the command dashboard source and its public OpenStreetMap snapshots. The root build builds the reviewer workspace first, then writes the command view into `apps/web/dist/command` for the gateway.

The first full-repository Replit publish was blocked by its scanner's Python/GPU dependency findings, including Pillow and Transformers. Those manifests belong to the Runpod backend and are excluded from the UI deployment artifact because the Node gateway does not use them. This is packaging separation, not a resolution of the backend findings. Keep Replit's security checks enabled and review backend advisories separately before broader adoption.

## Verification

```sh
npm run test:gateway
npm run build
PALLADIUM_BACKEND_ORIGIN=https://YOUR-POD-ID-8000.proxy.runpod.net npm start
```

Test sign-in, historical map, training-video playback and seeking, incident review, phone QR origin, frame ACKs and dashboard live status on the **published** URL. `/_health` reports only gateway readiness; `/api/health` requires the existing token and checks the actual GPU backend. The public Runpod URL remains a fallback while Replit is configured.

Sign in, check that the command center is connected, and stage a demo incident. Pair a simulated unit on a separate device, approve the recommendation, and check that acknowledging it from the officer page updates the dashboard.

References: [Replit deployment types](https://docs.replit.com/features/publishing/deployment-types), [configuration](https://docs.replit.com/features/project-setup/configuration), [publishing costs](https://docs.replit.com/billing/deployment-pricing).

## Published verification — November 14, 2026

The authenticated deployment at https://safe-sc.replit.app passed API sign-in, anonymous API rejection, the live event WebSocket, activity metadata, the 48-asset learning library, and original learning-video retrieval. A 16-frame synthetic JPEG phone-protocol test received all 16 ACKs, with mean ACK round trip 178.84 ms, maximum 315.49 ms, and total capture runtime 4.54 seconds. The source closed cleanly. This measures receipt over the Replit route; it does not establish model latency, detection accuracy, physical-phone behavior or sustained capacity. Original video retrieval returned a full HTTP 200 response, rather than a partial 206 response. Results and deployed/source commits are recorded in [the hosting check](https://github.com/adiv-1/SafeSC/blob/reviewed-learning/evaluation/replit-hosting.json) on the full source branch.

The gateway sends `Referrer-Policy: strict-origin-when-cross-origin`: OpenStreetMap requires a valid site referrer for its tiles. This sends only the public origin to tile servers, without incident paths or phone pairing fragments. The initial `no-referrer` policy caused blocked background tiles and was corrected before final visual verification.

## Activity forecasting release — November 14, 2026

The full-zone activity update was merged into GitHub `main`, exported to
`replit-ui`, pulled into the existing Replit project, and republished to
[Palladium Campus activity](https://safe-sc.replit.app/#activity). The Runpod backend
received the new authenticated bundle endpoint and prepared analysis without
replacing its historical or incident database. The backend restart was performed
only after confirming no active sources or pending jobs.

Live verification returned anonymous HTTP 401 and authenticated HTTP 200 for
the analysis bundle, containing 75,686 historical reports, 172 clipped forecast
areas, and 56 weekday/time windows per report family. The signed-in UI was
visually checked for satellite/aerial context, route alternatives, ambassador
planning, and changes after selecting tomorrow. The complete minimized public
activity snapshot, referenced source pages, checksums, and restore utility are
now included on `main` under `public-data/activity/`.

Release provenance and measured checks are recorded in
[the activity release verification](../../evaluation/campus-activity-release.json).
Forecasts remain exploratory three-hour seasonal estimates; pedestrian flow is
not included in route or staffing scores.
