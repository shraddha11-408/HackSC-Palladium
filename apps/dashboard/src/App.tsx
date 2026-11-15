import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import DeckGL from '@deck.gl/react';
import {FlyToInterpolator, type MapViewState, type PickingInfo} from '@deck.gl/core';
import {Map} from 'react-map-gl/maplibre';
import {buildLayers, type LayerToggles} from './layers';
import {darkCampusStyle} from './mapStyle';
import {arcPath, CAMPUS_CENTER, demoIncident, distance, makeCameras, makeOfficers, simulatedHistory} from './sim';
import {existingIncidents, fromPalladium, login, review, subscribe, type CascadeStats} from './live';
import {BottomBar, ConnectDialog, IncidentQueue, Legend, StatusStrip} from './Panels';
import {BuildingCard, IncidentDetail, UnitsPanel} from './DispatchPanels';
import {buildingAt, parseBuildings} from './buildings';
import {buildingTooltip, useLabelRows} from './buildingLabels';
import {acknowledge, arrive, AUTO_ACK_MS, cancel, clearUnit, createDispatch, POLICY, proposeUnits, remainingSeconds, resolve, tick, type DispatchState} from './dispatch';
import {dashboardRoom, openBus, type Assignment, type Bus, type BusMessage} from './bus';
import {INCIDENT_LABEL} from './types';
import {AlertPanel, PendingBanner} from './AlertPanel';
import {composeAlert, makeAppUsers, type ActiveAlert} from './alerts';
import {approvePlan, requestRecommendation, type Recommendation} from './agent';
import {demoEvidence, requestDebate, type DebateEvidence, type DebateResult} from './debate';
import {planIntercept, type InterceptPlan} from './intercept';
import {interceptLayers} from './interceptLayers';
import {InterceptPanel} from './InterceptPanel';
import {buildGraph, type Graph} from './analysis';
import {DEMO_SPEED} from './dispatch';
import type {Building, Dispatch, DispatchRecord, Funnel, HistoryPoint, Incident, Officer, Rack} from './types';

const GOOGLE_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '';
const OSM_PATH = `${import.meta.env.BASE_URL}osm/`;
const HOME: MapViewState = {longitude: CAMPUS_CENTER[0], latitude: CAMPUS_CENTER[1], zoom: 16.3, pitch: 58, bearing: -20};
const fly = new FlyToInterpolator();

type Mode = 'orbit' | 'focus' | 'dispatch';

export default function App({embedded}: {embedded: boolean}) {
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [racks, setRacks] = useState<Rack[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [ds, setDs] = useState<DispatchState>({officers: [], dispatches: []});
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [arcs, setArcs] = useState<Dispatch[]>([]);
  const [viewState, setViewState] = useState<MapViewState & Record<string, unknown>>(HOME);
  const [time, setTime] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<Mode>('orbit');
  const [mapMode, setMapMode] = useState<'google' | 'maplibre'>(GOOGLE_KEY ? 'google' : 'maplibre');
  const [credits, setCredits] = useState('');
  const [toggles, setToggles] = useState<LayerToggles>({history: false, coverage: true, racks: true});
  const [hour, setHour] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [cascade, setCascade] = useState<CascadeStats | null>(null);
  const [demoFunnel, setDemoFunnel] = useState({frames: 0, candidates: 0, vlmChecks: 0});
  const [devices, setDevices] = useState<Record<string, number>>({});
  const [relayUp, setRelayUp] = useState(false);
  const [recs, setRecs] = useState<Record<string, Recommendation>>({});
  const [recLoading, setRecLoading] = useState<Record<string, boolean>>({});
  const messagesRef = useRef<Record<string, {urgency: string; byUnit: Record<string, string>}>>({});

  const officers = ds.officers;
  const lastInteraction = useRef(0);
  const timeRef = useRef(0);
  const modeRef = useRef<Mode>('orbit');
  modeRef.current = mode;
  const dsRef = useRef(ds);
  dsRef.current = ds;
  const incidentsRef = useRef<Incident[]>([]);
  incidentsRef.current = incidents;
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const room = useMemo(() => dashboardRoom(), []);
  const buildingsRef = useRef<Building[]>([]);
  buildingsRef.current = buildings;
  const recsRef = useRef<Record<string, Recommendation>>({});
  recsRef.current = recs;
  const bus = useRef<Bus | null>(null);

  const cameras = useMemo(() => (buildings.length ? makeCameras(buildings) : []), [buildings]);
  const appUsers = useMemo(() => makeAppUsers(buildings), [buildings]);
  const [alertState, setAlertState] = useState<ActiveAlert | null>(null);
  const [debates, setDebates] = useState<Record<string, DebateResult>>({});
  const [debating, setDebating] = useState<Record<string, boolean>>({});
  const [graph, setGraph] = useState<Graph | null>(null);
  const graphRef = useRef<Graph | null>(null);
  graphRef.current = graph;
  const [intercept, setIntercept] = useState<{incidentId: string; plan: InterceptPlan; startedAt: number; approved: boolean} | null>(null);
  const trailsRef = useRef<Record<string, [number, number][]>>({});
  const interceptRef = useRef<typeof intercept>(null);
  interceptRef.current = intercept;
  const alertRef = useRef<ActiveAlert | null>(null);
  alertRef.current = alertState;
  const aiCameras = cameras.filter((c) => !c.watchedLive).length;
  const watchedLive = cameras.length - aiCameras;

  // ---- data ------------------------------------------------------------------------
  useEffect(() => {
    (async () => {
      const [r, b] = await Promise.all([
        fetch(`${OSM_PATH}racks.json`).then((response) => response.json()),
        fetch(`${OSM_PATH}buildings.json`).then((response) => response.json()),
      ]);
      const rackList: Rack[] = r.racks.map((x: any) => ({id: x.id, position: [x.lng, x.lat], capacity: x.capacity}));
      const buildingList = parseBuildings(b.buildings);
      setRacks(rackList);
      fetch(`${OSM_PATH}walk.json`).then((response) => response.json()).then((raw) => setGraph(buildGraph(raw))).catch(() => undefined);
      setBuildings(buildingList);
      setDs({officers: makeOfficers(buildingList), dispatches: []});
      try {
        const h = await fetch(`${OSM_PATH}history.json`);
        if (!h.ok || !(h.headers.get('content-type') || '').includes('json')) throw new Error('none');
        const rows = await h.json();
        setHistory(rows.map((p: any) => ({position: [p.lng, p.lat], hour: p.hour, type: p.type})));
      } catch {
        setHistory(simulatedHistory(buildingList, rackList));
      }
    })();
  }, []);

  // ---- animation clock, unit movement and camera orbit ------------------------------
  useEffect(() => {
    let frame = 0, last = performance.now(), lastRender = 0;
    const start = last;
    const loop = (t: number) => {
      const dt = (t - last) / 1000;
      last = t;
      timeRef.current = (t - start) / 1000;
      if (t - lastRender > 33) {
        lastRender = t;
        setTime(timeRef.current);
        setNow(Date.now());
        setDs((s) => {
          const {state, arrived} = tick(s, Date.now());
          if (arrived.length) setTimeout(() => setToast(`${arrived.map((a) => a.callsign).join(', ')} on scene`), 0);
          return state;
        });
      }
      const idle = Date.now() - lastInteraction.current > 10000;
      if ((modeRef.current === 'orbit' && idle) || modeRef.current === 'dispatch') {
        const speed = modeRef.current === 'dispatch' ? 6 : 3;
        setViewState((v) => (v.transitionDuration ? v : {...v, bearing: (v.bearing ?? 0) + speed * dt}));
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(id);
  }, [toast]);

  // ---- simulated funnel in demo mode ----------------------------------------------------
  useEffect(() => {
    if (cascade) return;
    const id = setInterval(() => setDemoFunnel((f) => ({
      frames: f.frames + aiCameras * 5,
      candidates: f.candidates + (Math.random() < 0.08 ? 1 : 0),
      vlmChecks: f.vlmChecks + (Math.random() < 0.05 ? 1 : 0),
    })), 1000);
    return () => clearInterval(id);
  }, [aiCameras, cascade]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setHour((h) => (h === null ? 0 : (h + 1) % 24)), 1200);
    return () => clearInterval(id);
  }, [playing]);

  const showToast = useCallback((text: string) => setToast(text), []);

  const flyTo = useCallback((v: Partial<MapViewState>, duration: number) => {
    setViewState((cur) => ({...cur, ...v, transitionDuration: duration, transitionInterpolator: fly}));
  }, []);

  const debate = useCallback(async (incident: Incident) => {
    setDebating((m) => ({...m, [incident.id]: true}));
    const demoType = incident.type === 'altercation' || incident.type === 'person_down' || incident.type === 'rack_activity' ? incident.type : null;
    const evidence: DebateEvidence = incident.origin === 'demo' && demoType
      ? {...demoEvidence(demoType, incident.variant ?? 'real'), observation: incident.observation, rule_evidence: incident.evidence}
      : {incident_type: incident.type, observation: incident.observation, rule_evidence: incident.evidence, features: {}};
    const result = await requestDebate(evidence);
    if (incident.origin === 'demo') result.simulated = true;
    setDebates((m) => ({...m, [incident.id]: result}));
    setDebating((m) => ({...m, [incident.id]: false}));
    setIncidents((list) => list.map((i) => (i.id === incident.id ? {...i, debate: result.decision, severity: result.decision === 'downgrade' ? 'WATCH' : i.severity} : i)));
  }, []);

  const assess = useCallback(async (incident: Incident) => {
    void debate(incident);
    setRecLoading((m) => ({...m, [incident.id]: true}));
    const building = buildingsRef.current.find((b) => b.id === incident.buildingId) ?? null;
    const rec = await requestRecommendation(incident, building, dsRef.current.officers);
    setRecs((m) => ({...m, [incident.id]: rec}));
    setRecLoading((m) => ({...m, [incident.id]: false}));
    setSelectedId((id) => {
      if (id === incident.id) setChosen(rec.units.map((u) => u.unit_id).filter((uid) => dsRef.current.officers.some((o) => o.id === uid && o.status === 'available')));
      return id;
    });
  }, []);

  const focus = useCallback((incident: Incident) => {
    setSelectedId(incident.id);
    setSelectedBuildingId(null);
    const existing = recsRef.current[incident.id];
    if (existing) setChosen(existing.units.map((u) => u.unit_id));
    else {
      setChosen(proposeUnits(dsRef.current.officers, incident).filter((u) => u.recommended).map((u) => u.officer.id));
      if (incident.status === 'unreviewed') void assess(incident);
    }
    const dispatched = incident.status === 'approved';
    setMode(dispatched ? 'dispatch' : 'focus');
    flyTo({longitude: incident.position[0], latitude: incident.position[1], zoom: dispatched ? 17.2 : 18.3, pitch: 62}, 2000);
  }, [flyTo, assess]);

  const backToOrbit = useCallback(() => {
    setMode('orbit');
    flyTo({longitude: HOME.longitude, latitude: HOME.latitude, zoom: HOME.zoom, pitch: HOME.pitch}, 2200);
  }, [flyTo]);

  const addIncident = useCallback((incident: Incident) => {
    const withBuilding = {...incident, buildingId: incident.buildingId ?? buildingAt(buildings, incident.position)?.id};
    setIncidents((list) => (list.some((i) => i.id === incident.id) ? list : [withBuilding, ...list]));
    if (incident.status === 'unreviewed') focus(withBuilding);
  }, [focus, buildings]);

  const stageDemo = useCallback((variant?: unknown) => {
    if (!buildings.length) return;
    addIncident(demoIncident(buildings, racks, cameras, variant === 'benign' ? 'benign' : 'real'));
    setDemoFunnel((f) => ({...f, candidates: f.candidates + 3, vlmChecks: f.vlmChecks + 1}));
  }, [buildings, racks, cameras, addIncident]);

  // ---- officer phones ---------------------------------------------------------------------
  const assignmentFor = useCallback((unit: Officer, s: DispatchState): Assignment | null => {
    const d = s.dispatches.find((x) => x.id === unit.dispatchId);
    const incident = d && incidentsRef.current.find((i) => i.id === d.incidentId);
    if (!d || !incident) return null;
    const b = buildings.find((x) => x.id === incident.buildingId);
    return {
      dispatchId: d.id, incidentId: incident.id, label: INCIDENT_LABEL[incident.type], severity: incident.severity,
      priority: d.priority, place: b?.name ?? incident.place,
      address: b ? [b.tags['addr:housenumber'], b.tags['addr:street']].filter(Boolean).join(' ') || undefined : undefined,
      floors: b?.tags['building:levels'], observation: incident.observation, reason: d.reason, support: d.support,
      position: incident.position, partners: s.officers.filter((o) => d.unitIds.includes(o.id) && o.id !== unit.id).map((o) => o.callsign),
      assignedAt: unit.assignedAt ?? d.createdAt,
      message: messagesRef.current[d.id]?.byUnit[unit.id], urgency: messagesRef.current[d.id]?.urgency,
    };
  }, [buildings]);

  const publish = useCallback((unit: Officer, s: DispatchState) => {
    bus.current?.send({type: 'state', unitId: unit.id, callsign: unit.callsign, status: unit.status,
      assignment: unit.status === 'available' ? null : assignmentFor(unit, s),
      etaSeconds: unit.route ? remainingSeconds(unit.route, Date.now()) : undefined});
  }, [assignmentFor]);

  const apply = useCallback((f: (s: DispatchState) => DispatchState) => {
    setDs((s) => {
      const next = f(s);
      // Tell phones about every unit whose state changed.
      for (const unit of next.officers) {
        const before = s.officers.find((o) => o.id === unit.id);
        if (!before || before.status !== unit.status || before.dispatchId !== unit.dispatchId) setTimeout(() => publish(unit, next), 0);
      }
      return next;
    });
  }, [publish]);

  const onBus = useCallback((m: BusMessage) => {
    if (m.type === 'presence' || m.type === 'hello') {
      setDevices((d) => ({...d, [m.unitId]: Date.now()}));
      if (m.type === 'hello') {
        const unit = dsRef.current.officers.find((o) => o.id === m.unitId);
        if (unit) publish(unit, dsRef.current);
      }
      return;
    }
    if (m.type === 'state' || m.type === 'alert') return;
    const unit = dsRef.current.officers.find((o) => o.id === m.unitId);
    if (!unit || unit.dispatchId !== m.dispatchId) return;
    const d = dsRef.current.dispatches.find((x) => x.id === m.dispatchId);
    const incident = d && incidentsRef.current.find((i) => i.id === d.incidentId);
    const t = Date.now();
    if (m.type === 'ack' && incident) apply((s) => acknowledge(s, unit.id, incident.position, t, 'from phone'));
    if (m.type === 'arrived') apply((s) => arrive(s, unit.id, t));
    if (m.type === 'clear') {
      apply((s) => clearUnit(s, unit.id, t, 'from phone'));
      setToast(`${unit.callsign} cleared`);
    }
  }, [apply, publish]);

  useEffect(() => {
    bus.current = openBus(room, (m) => onBusRef.current(m));
    const id = setInterval(() => setRelayUp(!!bus.current?.relay()), 1500);
    return () => {clearInterval(id); bus.current?.close();};
  }, [room]);
  const onBusRef = useRef(onBus);
  onBusRef.current = onBus;

  // Units with no phone linked acknowledge on their own, so the demo still runs (marked simulated).
  useEffect(() => {
    for (const unit of officers) {
      if (unit.status !== 'assigned' || !unit.assignedAt) continue;
      const hasPhone = devices[unit.id] && Date.now() - devices[unit.id] < 7000;
      if (hasPhone || Date.now() - unit.assignedAt < AUTO_ACK_MS) continue;
      const d = ds.dispatches.find((x) => x.id === unit.dispatchId);
      const incident = d && incidents.find((i) => i.id === d.incidentId);
      if (incident) apply((s) => acknowledge(s, unit.id, incident.position, Date.now(), 'auto (no phone linked; simulated)'));
    }
  }, [now, officers, devices, ds.dispatches, incidents, apply]);

  // ---- keyboard ----------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'd' || e.key === 'D') stageDemo();
      if (e.key === 'f' || e.key === 'F') stageDemo('benign');
      if ((e.key === 'm' || e.key === 'M') && GOOGLE_KEY) setMapMode((m) => (m === 'google' ? 'maplibre' : 'google'));
      if (e.key === 'Escape') {setSelectedId(null); setSelectedBuildingId(null); backToOrbit();}
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stageDemo, backToOrbit]);

  const selected = incidents.find((i) => i.id === selectedId) ?? null;
  const selectedDispatch: DispatchRecord | null = selected?.dispatchId ? ds.dispatches.find((d) => d.id === selected.dispatchId) ?? null : null;
  const proposals = selected && selected.status === 'unreviewed' ? proposeUnits(officers, selected) : [];
  const selectedBuilding = buildings.find((b) => b.id === (selectedBuildingId ?? selected?.buildingId)) ?? null;

  // ---- decisions -----------------------------------------------------------------------------
  const dispatchUnits = useCallback(async () => {
    const incident = incidentsRef.current.find((i) => i.id === selectedId);
    if (!incident || incident.status !== 'unreviewed' || !chosen.length) return;
    const units = dsRef.current.officers.filter((o) => chosen.includes(o.id) && o.status === 'available');
    if (!units.length) {showToast('Chosen units are no longer available'); return;}
    if (incident.origin === 'live') {
      try {
        await review(incident.id, 'confirmed', `Dispatched ${units.map((u) => u.callsign).join(', ')} (${POLICY[incident.type].priority}) from the command view; units simulated`);
      } catch (e) {
        showToast(`Could not record the decision: ${(e as Error).message}`);
        return;
      }
    }
    const rec = recsRef.current[incident.id];
    const messages = rec ? await approvePlan(rec, units.map((u) => u.id), 'Approved on the command view') : {};
    const t = Date.now();
    const {state, dispatch} = createDispatch(dsRef.current, incident, units.map((u) => u.id), t);
    messagesRef.current[dispatch.id] = {urgency: rec?.urgency ?? '', byUnit: messages};
    apply(() => state);
    setIncidents((list) => list.map((i) => (i.id === incident.id ? {...i, status: 'approved', dispatchId: dispatch.id, officerId: units[0].id, decidedAt: t} : i)));
    setArcs((list) => [...list, ...units.map((u) => ({incidentId: incident.id, officerId: u.id, path: arcPath(u.position, incident.position), startedAt: timeRef.current, seconds: 2.2}))]);
    setTimeout(() => setArcs((list) => list.filter((a) => a.incidentId !== incident.id)), 4500);
    // The alert agent: notify every DPS unit and app users within 200 m, and file the incident report.
    const alertNow = composeAlert(incident, buildings.find((b) => b.id === incident.buildingId), dsRef.current.officers, appUsers, units, timeRef.current);
    setAlertState(alertNow);
    bus.current?.send({type: 'alert', alert: alertNow.msg});
    if (incident.heading !== undefined && graphRef.current) {
      const free = dsRef.current.officers.filter((o) => o.status === 'available' && !units.some((u) => u.id === o.id));
      const plan = planIntercept({graph: graphRef.current, cameras, buildings, incident: incident.position, heading: incident.heading, units: free, victim: incident.position});
      setIntercept(plan ? {incidentId: incident.id, plan, startedAt: timeRef.current, approved: false} : null);
    }
    setMode('dispatch');
    const far = units.reduce((m, u) => Math.max(m, distance(u.position, incident.position)), 0);
    flyTo({longitude: incident.position[0], latitude: incident.position[1], zoom: far > 400 ? 16.4 : 17.1, pitch: 58}, 1600);
    const phones = units.filter((u) => devicesRef.current[u.id] && Date.now() - devicesRef.current[u.id] < 7000);
    showToast(`Agent contacted ${units.map((u) => u.callsign).join(' + ')}${phones.length ? ` · ${phones.length} phone${phones.length > 1 ? 's' : ''} notified` : ' · no phones linked, auto-acknowledging'}`);
  }, [selectedId, chosen, apply, flyTo, showToast, buildings, appUsers, cameras]);

  // Breadcrumb track for every dispatched unit; idle units have no track.
  useEffect(() => {
    const trails = trailsRef.current;
    for (const o of officers) {
      if (o.status === 'available') {delete trails[o.id]; continue;}
      const track = trails[o.id] ?? (trails[o.id] = []);
      const last = track[track.length - 1];
      if (!last || distance(last, o.position) > 2) {track.push(o.position); if (track.length > 90) track.shift();}
    }
  }, [officers]);

  // Standalone page: bring the alert report and the intercept plan into view when they appear.
  useEffect(() => {
    if (embedded || !alertState) return;
    const id = setTimeout(() => document.querySelector('.command-review .alert-panel')?.scrollIntoView({behavior: 'smooth', block: 'center'}), 500);
    return () => clearTimeout(id);
  }, [embedded, alertState?.msg.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const approveIntercept = useCallback(() => {
    const sel = interceptRef.current;
    if (!sel) return;
    const t = Date.now();
    apply((s) => {
      const incident = incidentsRef.current.find((i) => i.id === sel.incidentId);
      const did = incident?.dispatchId;
      if (!did) return s;
      const moving = sel.plan.chokePoints.filter((c) => s.officers.some((o) => o.id === c.unit.id && o.status === 'available'));
      const officers = s.officers.map((o) => {
        const c = moving.find((m) => m.unit.id === o.id);
        return c ? {...o, status: 'en_route' as const, dispatchId: did, assignedAt: t, busyWith: sel.incidentId,
          route: {from: o.position, to: c.position, path: c.path, startedAt: t, seconds: Math.max(4, c.unitEtaS / DEMO_SPEED)}} : o;
      });
      const dispatches = s.dispatches.map((d) => (d.id === did ? {...d, unitIds: [...d.unitIds, ...moving.map((m) => m.unit.id)],
        events: [...d.events, ...moving.map((m) => ({at: t, kind: 'en_route' as const, unitId: m.unit.id, note: `intercept point, ${Math.round(m.marginS)} s ahead of the suspect (agent)`}))]} : d));
      return {officers, dispatches};
    });
    setIntercept({...sel, approved: true, startedAt: timeRef.current});
    showToast('Intercept approved: units rerouted to choke points');
  }, [apply, showToast]);

  const finishIncident = useCallback((status: 'resolved', dispatchId: string) => {
    const t = Date.now();
    apply((s) => resolve(s, dispatchId, t));
    setIncidents((list) => list.map((i) => (i.dispatchId === dispatchId ? {...i, status} : i)));
    showToast('Incident resolved, units back in service');
    setIntercept(null);
    const open = alertRef.current;
    if (open) {
      bus.current?.send({type: 'alert', alert: {...open.msg, id: open.msg.id.replace('alert-', 'clear-'), kind: 'clear', title: 'All clear', message: 'The incident is resolved.', at: Date.now()}});
      setAlertState(null);
    }
  }, [apply, showToast]);

  // Resolve the incident once every unit has cleared from the phones.
  useEffect(() => {
    for (const d of ds.dispatches) {
      if (d.status === 'resolved') {
        const incident = incidents.find((i) => i.dispatchId === d.id);
        if (incident && incident.status === 'approved') setIncidents((list) => list.map((i) => (i.id === incident.id ? {...i, status: 'resolved'} : i)));
      }
    }
  }, [ds.dispatches, incidents]);

  const cancelDispatch = useCallback((dispatchId: string) => {
    apply((s) => cancel(s, dispatchId, Date.now()));
    setIncidents((list) => list.map((i) => (i.dispatchId === dispatchId ? {...i, status: 'unreviewed', dispatchId: undefined} : i)));
    showToast('Dispatch cancelled; the incident is back in the queue');
  }, [apply, showToast]);

  const dismiss = useCallback(async () => {
    const incident = incidentsRef.current.find((i) => i.id === selectedId);
    if (!incident) return;
    if (incident.origin === 'live') {
      try {await review(incident.id, 'dismissed', 'Dismissed on the command view');}
      catch (e) {showToast(`Could not record dismissal: ${(e as Error).message}`); return;}
    }
    setIncidents((list) => list.map((i) => (i.id === incident.id ? {...i, status: 'dismissed', decidedAt: Date.now()} : i)));
    setSelectedId(null);
    backToOrbit();
  }, [selectedId, showToast, backToOrbit]);

  // ---- live Palladium ------------------------------------------------------------------------------
  const unsubscribe = useRef<(() => void) | null>(null);
  useEffect(() => () => unsubscribe.current?.(), []);
  const connect = useCallback(async (token?: string, signal?: AbortSignal) => {
    if (!cameras.length) throw new Error('Campus data is still loading');
    if (token !== undefined) await login(token);
    const existing = await existingIncidents(signal);
    if (signal?.aborted) return;
    setIncidents((list) => [...existing.map((raw) => {
      const i = fromPalladium(raw, cameras);
      return {...i, buildingId: buildingAt(buildings, i.position)?.id};
    }), ...list.filter((i) => i.origin === 'demo')]);
    unsubscribe.current?.();
    unsubscribe.current = subscribe({
      incident: (raw) => addIncident(fromPalladium(raw, cameras)),
      source: (raw) => {if (raw?.telemetry?.cascade) setCascade(raw.telemetry.cascade);},
      status: setLiveStatus,
    });
    setLiveStatus('connected');
    setConnectOpen(false);
    if (!signal) showToast(`Connected to Palladium: ${existing.length} incidents loaded`);
  }, [cameras, buildings, addIncident, showToast]);
  useEffect(() => {
    if (!embedded || !cameras.length) return;
    const attempt = new AbortController();
    void connect(undefined, attempt.signal).catch(() => {
      if (!attempt.signal.aborted) setLiveStatus('disconnected');
    });
    return () => attempt.abort();
  }, [embedded, cameras.length, connect]);

  // ---- counters -----------------------------------------------------------------------------------
  const approvedCount = incidents.filter((i) => i.status === 'approved' || i.status === 'resolved').length;
  const funnel: Funnel = cascade
    ? {frames: cascade.frames, candidates: Object.values(cascade.candidates || {}).reduce((a, b) => a + b, 0),
       vlmChecks: cascade.tier2_vlm_calls, alerts: incidents.length, approved: approvedCount}
    : {...demoFunnel, alerts: incidents.length, approved: approvedCount};
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const costToday = (aiCameras / 40) * 0.6 * ((Date.now() - midnight.getTime()) / 3.6e6);

  const google = mapMode === 'google' && GOOGLE_KEY ? {key: GOOGLE_KEY, onCredits: setCredits} : null;
  const focusBuildingId = selectedBuildingId ?? selected?.buildingId ?? null;
  const labelRows = useLabelRows(buildings, viewState, focusBuildingId, '.command-canvas');
  const layers = buildLayers({time, incidents, selectedId, officers, cameras, racks, history, hour, dispatches: arcs, toggles, google,
    buildings, focusBuildingId, labelRows, now, orbiting: mode === 'orbit',
    alert: alertState ? {center: alertState.msg.center, startedAt: alertState.startedAt, radius: alertState.msg.radius, users: alertState.users} : null,
    extra: intercept ? interceptLayers(intercept.plan, intercept.startedAt, time, intercept.approved) : undefined,
    trails: Object.entries(trailsRef.current).map(([id, path]) => ({id, path}))});

  const tooltip = ({object, layer}: PickingInfo) => {
    if (!object || !layer) return null;
    if (layer.id === 'unit-cars') return {text: `${object.o.callsign} · ${object.o.mode} · ${object.o.status} · simulated unit`};
    if (layer.id === 'officers') return {text: `${object.callsign} · ${object.mode} · ${object.status} · simulated unit`};
    if (layer.id === 'camera-cones') return {text: `${object.id} near ${object.near} · ${object.watchedLive ? 'watched live' : 'AI triaged'} · simulated position`};
    if (layer.id === 'beams') return {text: `${object.place}: ${object.observation}`};
    if (layer.id === 'footprints') return {text: buildingTooltip(object as Building)};
    return null;
  };

  const racksNear = selectedBuilding ? racks.filter((r) => distance(r.position, selectedBuilding.position) < 60).length : 0;
  const camsNear = selectedBuilding ? cameras.filter((c) => distance(c.position, selectedBuilding.position) < 60).length : 0;

  return (
    <div className={`app command-center${embedded ? ' embedded' : ''}`}>
      <StatusStrip camerasTriaged={aiCameras} watchedLive={watchedLive} vlmCalls={funnel.vlmChecks} costToday={costToday}
        liveMetrics={!!cascade} costProvenance="estimate" mapMode={mapMode} googleAvailable={!!GOOGLE_KEY}
        onToggleMap={() => GOOGLE_KEY && setMapMode((m) => (m === 'google' ? 'maplibre' : 'google'))}
        liveStatus={liveStatus} demoReady={!!buildings.length} onDemo={stageDemo} onFalseAlarm={() => stageDemo('benign')}
        onConnect={() => {void connect().catch(() => setConnectOpen(true));}} />
      <main className="command-grid">
        <section className="panel command-map" aria-label="Interactive 3D campus map">
          <div className="command-map-label"><strong>University Park</strong><span>3D campus map</span></div>
          <div className="command-canvas">
            <DeckGL
              viewState={viewState}
              controller={{inertia: 300}}
              layers={layers}
              getTooltip={tooltip as any}
              onViewStateChange={({viewState: v, interactionState}) => {
                if (interactionState?.isDragging || interactionState?.isZooming || interactionState?.isPanning || interactionState?.isRotating) {
                  lastInteraction.current = Date.now();
                }
                setViewState(v as MapViewState);
              }}
              onClick={({object, layer}) => {
                if (layer?.id === 'beams' && object) focus(object as Incident);
                else if (layer?.id === 'footprints' && object) {
                  const b = object as Building;
                  setSelectedId(null);
                  setSelectedBuildingId(b.id);
                  setMode('focus');
                  flyTo({longitude: b.position[0], latitude: b.position[1], zoom: 18, pitch: 60}, 1400);
                }
              }}
            >
              {mapMode === 'maplibre' && <Map mapStyle={darkCampusStyle} reuseMaps attributionControl={{compact: true}} />}
            </DeckGL>
          </div>
          {mapMode === 'google' && <div className="credits">Google · {credits}</div>}
          <Legend />
          <PendingBanner incidents={incidents} onReview={focus} />
        </section>
        <div className="command-review">
          <IncidentQueue incidents={incidents} selectedId={selectedId} onSelect={(id: string) => {const i = incidents.find((x) => x.id === id); if (i) focus(i);}}
          />
          {selected ? (
            <IncidentDetail incident={selected} building={selectedBuilding} officers={officers} proposals={proposals} chosen={chosen}
              onToggleUnit={(id) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))}
              dispatch={selectedDispatch} devices={devices} onDispatch={dispatchUnits} onDismiss={dismiss}
              rec={recs[selected.id] ?? null} recLoading={!!recLoading[selected.id]} onReassess={() => void assess(selected)}
              onResolve={() => selectedDispatch && finishIncident('resolved', selectedDispatch.id)}
              onCancel={() => selectedDispatch && cancelDispatch(selectedDispatch.id)}
              brief={debates[selected.id] ?? null} briefLoading={!!debating[selected.id]}
              onClose={() => {setSelectedId(null); backToOrbit();}} />
          ) : (
            <BuildingCard building={selectedBuilding} racksNearby={racksNear} camerasNearby={camsNear}
              onClose={() => {setSelectedBuildingId(null); backToOrbit();}} />
          )}
          {alertState && <AlertPanel alert={alertState} devices={devices} onClose={() => setAlertState(null)} />}
          {intercept && selected?.id === intercept.incidentId && (
            <InterceptPanel plan={intercept.plan} approved={intercept.approved} onDismiss={() => setIntercept(null)} onApprove={approveIntercept} />
          )}
        </div>
      </main>
      <div className="command-tools">
        <UnitsPanel officers={officers} devices={devices} room={room} relay={relayUp}
          onFocus={(o) => {lastInteraction.current = Date.now(); flyTo({longitude: o.position[0], latitude: o.position[1], zoom: 18, pitch: 55}, 1200);}} />
        <BottomBar hour={hour} setHour={setHour} playing={playing} setPlaying={setPlaying} funnel={funnel} toggles={toggles} setToggles={setToggles} />
      </div>
      {toast && <div className="toast" key={toast}>{toast}</div>}
      <ConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} onSubmit={connect} />
    </div>
  );
}
