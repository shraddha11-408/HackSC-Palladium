// Connection to a running Palladium API (through the Vite proxy in development).
// Palladium incidents carry no location, so each source is pinned to a simulated camera.
import type {Camera, Incident, IncidentType, Severity} from './types';

export type CascadeStats = {
  frames: number;
  candidates: Record<string, number>;
  alerts: Record<string, number>;
  tier2_vlm_calls: number;
  tier0_ms_per_frame: number;
  camera_equivalents_this_device: number | null;
};

const TYPES: IncidentType[] = ['person_down', 'altercation', 'rack_activity'];
const SEVERITIES: Severity[] = ['HIGH_PRIORITY_REVIEW', 'REVIEW_REQUIRED', 'WATCH'];

function hash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function cameraForSource(sourceId: string, cameras: Camera[]) {
  return cameras[hash(sourceId) % cameras.length];
}

export function fromPalladium(raw: any, cameras: Camera[]): Incident {
  const record = raw.record || {};
  const camera = cameraForSource(raw.source_id || raw.id, cameras);
  const event = record.observable_events?.[0];
  const type: IncidentType = TYPES.includes(record.incident_type) ? record.incident_type : 'other';
  const severity: Severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'REVIEW_REQUIRED';
  const status = raw.review_status === 'confirmed' ? 'approved' : raw.review_status === 'dismissed' ? 'dismissed' : 'unreviewed';
  return {
    id: raw.id, type, severity, position: camera.position, place: `${camera.near} (simulated camera position)`,
    cameraId: camera.id, createdAt: Date.parse(raw.created_at) || Date.now(), status,
    observation: event?.observation || 'Possible safety incident', evidence: record.rule_evidence || [],
    uncertainties: record.uncertainties || [], confidence: raw.confidence ?? 0, origin: 'live',
    thumbnail: `/api/incidents/${raw.id}/media/thumbnail`,
  };
}

export async function login(token: string) {
  const r = await fetch('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({token})});
  if (!r.ok) throw new Error(r.status === 401 ? 'Wrong access token' : `Login failed (${r.status})`);
}

export async function existingIncidents(signal?: AbortSignal): Promise<any[]> {
  const r = await fetch('/api/incidents', {signal});
  if (!r.ok) throw new Error(`Could not load incidents (${r.status})`);
  return r.json();
}

export async function review(id: string, decision: 'confirmed' | 'dismissed', note: string) {
  const r = await fetch(`/api/incidents/${id}/review`, {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({decision, note})});
  if (!r.ok) throw new Error(`Review failed (${r.status})`);
}

export function subscribe(handlers: {incident: (raw: any) => void; source: (raw: any) => void; status: (s: string) => void}) {
  let socket: WebSocket | null = null, closed = false, retry = 0;
  const open = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
    socket.onopen = () => {retry = 0; handlers.status('connected');};
    socket.onmessage = (m) => {
      const event = JSON.parse(m.data);
      if (event.type === 'incident') handlers.incident(event.payload);
      if (event.type === 'source') handlers.source(event.payload);
    };
    socket.onclose = (e) => {
      if (closed) return;
      handlers.status(e.code === 4401 ? 'unauthorized' : 'reconnecting');
      if (e.code !== 4401) setTimeout(open, Math.min(10000, 1000 * 2 ** retry++));
    };
  };
  open();
  return () => {closed = true; socket?.close();};
}
