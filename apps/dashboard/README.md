# Palladium 3D command dashboard

A full-screen 3D view of USC for the dispatcher. Live incident beams pulse until someone reviews them. Approving an incident sends the nearest officer, shown as an animated arc. Hexagon columns show history by hour of day, and camera cones show how much of campus is watched live and how much is AI triaged. Every layer is labelled Real, Demo, Simulated or Estimate.

## Run

```bash
cd apps/dashboard
npm install
npm run dev        # http://localhost:5174
```

The hosted site opens the **Command center** in the signed-in reviewer workspace. The dashboard also has a direct route at `/command/`. Officer links use that route with the unit and room in the query string.

Press **D**, or click **Stage demo incident**, to fire a staged event.

| Key | Action |
|---|---|
| D | Stage a demo incident |
| M | Switch map mode (Google 3D Tiles / MapLibre fallback) |

### Map modes

- **Google Photorealistic 3D Tiles:** set `VITE_GOOGLE_MAPS_API_KEY` in `apps/dashboard/.env` and enable the Map Tiles API for that key. Check pricing and quotas first; we have not verified them, and we have not tested this mode with a real key.
- **MapLibre fallback (default):** OpenFreeMap vector tiles with extruded OSM buildings in a dark style. It's free, needs no key and works on poor wifi.

### Connect to a live Palladium

1. Run the Palladium API on `:8000` (`STREAMING_MODEL=cascade` is recommended).
2. In the dashboard, click **Connect Palladium**. If prompted, enter the token from `data/app_token`.

Vite proxies `/api` and `/ws` to the API. Set `PALLADIUM_API` to point the proxy somewhere else. Palladium sources carry no location, so live incidents are pinned to **simulated** camera positions.

## AI dispatch agent

When an incident is selected, the Palladium backend's dispatch agent (Claude, model from `DISPATCH_AGENT_MODEL`, default `claude-opus-5-5`) reads the incident and the position, status and ETA of every unit stationed on campus. It recommends:

- which units to send
- an urgency level (critical, high, moderate or low) and a priority (P1 to P3)
- a two-sentence overview
- support to request
- cautions
- a short outreach message per unit

**Human in the loop.** The person monitoring reviews the recommendation and can untick units. Nothing is sent until they press **"Approve — agent contacts N units"**. Approval is recorded in `data/dispatch_audit.jsonl` on the Palladium server. The agent's messages then go to the units' phones (officer page), and the units travel to the site.

**Endpoints** (reviewer login required):

- `POST /api/dispatch/recommend`
- `POST /api/dispatch/approve`

**Setup:**

1. Set `ANTHROPIC_API_KEY` (and optionally `DISPATCH_AGENT_MODEL`) in the Palladium `.env`.
2. Start the API on port 8000.
3. In the dashboard, click **Connect Palladium** and enter the token from `data/app_token`.

**Fallback.** Without a key, or if the API is unreachable, the dashboard shows a rules-based plan with the same layout, clearly labelled **"Rules fallback"**. Model calls are logged to `data/dispatch_agent_usage.jsonl`.

**Honesty notes.** Units and officers are simulated. EMS "requests" are not sent anywhere. The agent never infers identity, guilt or ownership.

## Data provenance

| Data | Source | Label on screen |
|---|---|---|
| Bike racks, buildings | OpenStreetMap via `scripts/build_osm_data.py` (© OpenStreetMap contributors, ODbL) | Real |
| Live incidents | Staged events, or a connected Palladium | Demo / Live |
| Camera positions, officer roster | Invented; deliberately **not** real DPS camera locations | Simulated |
| History columns | Simulated until `public/osm/history.json` exists | Simulated |
| Cost today | $0.60/h per L4 GPU at 40 cameras per GPU, from the feasibility brief; not measured | Estimate |

**Real history:** geocode the DPS daily crime log (hand-mapping the top ~30 locations is enough) and save it as `public/osm/history.json`:

```json
[{"lat": 34.0224, "lng": -118.2910, "hour": 21, "type": "rack_activity"}]
```

`type` is one of `person_down`, `altercation` or `rack_activity`; `hour` is 0 to 23.

## Demo script for judges

1. **Idle:** the camera slowly orbits campus at dusk.
2. **Stage an incident:** press D. A beam appears and the alert card slides in.
3. **Fly-in:** the camera drops to the building in about 2 seconds, and the card shows evidence and the recommended responder.
4. **Approve:** the beam turns steady.
5. **Dispatch:** the camera pulls back to show the arc from the officer to the incident, and the officer ping appears. Then it returns to orbit.
6. **History:** drag the hour slider to 9 PM and watch the columns rise around the bike racks.

## Known limits

- Google 3D Tiles are not desaturated, and that mode is untested with a real key.
- Officer links open a browser-based view for simulated units.
- History is simulated until a geocoded DPS log is added.


## Pages, alerts and the new agents (PR 2)

One app, four pages behind the hash router: **Trends** (`#/trends`, the default), **Incidents** (`#/incidents`), **Live** (`#/live`) and **About** (`#/about`). `?app=1` opens the student alert app and `?unit=...&room=...` the officer page.

| Feature | Where | What it does | Status |
|---|---|---|---|
| Ambassador posts | Trends, "Ambassador posts" | Weighted k-means over past incidents in a shift, snapped to real OSM walkways, with a before/after coverage meter and a "why here" panel | Algorithm tested in a browser; history is **simulated** until `public/osm/history.json` exists |
| Get Somewhere | Trends, "Get Somewhere" | Place autocomplete, then a fastest route and a safest route (Dijkstra on 4,756 OSM walkway nodes, edges penalised by nearby past incidents) | Works; OSM maps plazas as areas, so open crossings are missing and routes can run 1.4 to 2 times the straight-line distance |
| What-if sandbox | Trends, "What-if" | Monte Carlo of 3,000 to 10,000 late-night walks. Levers: Free Lyft boundary cut, ambassadors off duty, walkers, Lyft usage. Compares today, no re-plan, and re-plan | Scenario simulator with stated assumptions, **not a crime prediction**; the Lyft boundary is the approximate polygon in `docs/` |
| Incident dashboard | Incidents | KPIs, hour and 13-week charts, top locations, filterable log | Simulated history |
| 200 m alerts | Live, after Approve | Alert agent notifies all DPS units and every app user inside 200 m, files an incident report | Delivery is simulated; the geofence is real: open `?app=1` pages and pick locations to see only nearby phones alert |
| Incident report | Live | Report with placeholder descriptors | **Hard-coded placeholder values** for testing the alert flow. The vision pipeline does not estimate them and Palladium never infers identity or demographics |
| Agent debate | Live, incident card | Threat agent vs Devil's Advocate answer typed questions in parallel; a 3-bullet consensus brief explains why the alert was escalated, downgraded or suppressed. Press **F** or "Stage false alarm" for a benign look-alike | Rules gate tested (sub-millisecond). Claude gate is wired but **never run against the real API** (no key). `JevGate` is a placeholder: the vendor API and its latency and cost claims are unverified |
| Intercept vector | Live, after Approve | Projects the escape heading over the walkway graph for 45 s, hands off to cameras, picks choke points other units can reach first, and routes the victim to a safe haven. A second human approval moves the units | Heuristic; the heading is a **simulated input**. Some headings give no interceptable path and the panel says so |

Keys on Live: **D** stages an incident (the first is an altercation at Lyon Recreation Center), **F** stages a false alarm.
