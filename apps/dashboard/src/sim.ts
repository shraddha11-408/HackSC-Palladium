// Everything in this file is invented for the demo and is labelled "Simulated" on screen.
// Camera positions are deliberately NOT real DPS camera locations; they are scattered
// around real OpenStreetMap buildings so the coverage story reads correctly.
import type {Building, Camera, HistoryPoint, Incident, IncidentType, LngLat, Officer, Rack, Severity} from './types';

export const CAMPUS_CENTER: LngLat = [-118.2856, 34.0207];
const CAMPUS = {south: 34.0175, north: 34.0262, west: -118.2915, east: -118.2805};

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG = 111_320;
export function offset([lng, lat]: LngLat, east: number, north: number): LngLat {
  return [lng + east / (M_PER_DEG * Math.cos((lat * Math.PI) / 180)), lat + north / M_PER_DEG];
}
export function distance(a: LngLat, b: LngLat) {
  const dx = (b[0] - a[0]) * M_PER_DEG * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (b[1] - a[1]) * M_PER_DEG;
  return Math.hypot(dx, dy);
}
export function nearest<T extends {position: LngLat}>(items: T[], to: LngLat) {
  let best: T | undefined, bestD = Infinity;
  for (const item of items) {
    const d = distance(item.position, to);
    if (d < bestD) [best, bestD] = [item, d];
  }
  return best ? {item: best, metres: bestD} : undefined;
}
export const onCampus = ([lng, lat]: LngLat) =>
  lat > CAMPUS.south && lat < CAMPUS.north && lng > CAMPUS.west && lng < CAMPUS.east;

export function makeCameras(buildings: Building[]): Camera[] {
  const random = rng(4000);
  const cameras: Camera[] = [];
  for (const b of buildings.filter((b) => onCampus(b.position))) {
    const count = random() < 0.55 ? 1 : 2;
    for (let n = 0; n < count; n++) {
      const angle = random() * Math.PI * 2, r = 14 + random() * 22;
      cameras.push({id: `cam-${cameras.length + 1}`, near: b.name,
        position: offset(b.position, Math.cos(angle) * r, Math.sin(angle) * r),
        heading: random() * 360, fov: 58 + random() * 30, range: 30 + random() * 25, watchedLive: false});
    }
  }
  // About 150 of 4,000 USC cameras are watched live (3.75%); mirror that ratio.
  const watched = Math.max(1, Math.round(cameras.length * 0.0375));
  for (let i = 0; i < watched; i++) cameras[Math.floor(random() * cameras.length)].watchedLive = true;
  return cameras;
}

export function cameraCone(c: Camera): LngLat[] {
  const points: LngLat[] = [c.position];
  for (let i = 0; i <= 12; i++) {
    const a = ((c.heading - c.fov / 2 + (c.fov * i) / 12) * Math.PI) / 180;
    points.push(offset(c.position, Math.sin(a) * c.range, Math.cos(a) * c.range));
  }
  return points;
}

export function makeOfficers(buildings: Building[]): Officer[] {
  const at = (name: string, fallback: LngLat) => buildings.find((b) => b.name.includes(name))?.position ?? fallback;
  const spots: [string, Officer['mode'], string][] = [
    ['Trojan 11', 'bike', 'Ronald Tutor Campus Center'],
    ['Trojan 14', 'foot', 'Leavey Library'],
    ['Trojan 22', 'bike', 'Kaprielian Hall'],
    ['Trojan 31', 'cart', 'Lyon Recreation Center'],
    ['Trojan 35', 'foot', 'Watt Hall'],
    ['Trojan 40', 'bike', 'Fertitta Hall'],
    ['Trojan 46', 'bike', 'Ginsburg Hall'],
    ['Trojan 52', 'foot', 'Taper Hall'],
  ];
  return spots.map(([callsign, mode, place], i) => ({id: `officer-${i + 1}`, callsign, mode, status: 'available' as const,
    position: offset(at(place, CAMPUS_CENTER), 25, -18)}));
}

const SPEED: Record<Officer['mode'], number> = {foot: 1.4, bike: 4.5, cart: 6};
export function etaSeconds(o: Officer, to: LngLat) {
  return (distance(o.position, to) * 1.3) / SPEED[o.mode]; // 1.3: paths are not straight lines
}

export function recommend(officers: Officer[], to: LngLat) {
  return officers.filter((o) => !o.busyWith).map((o) => ({officer: o, eta: etaSeconds(o, to)}))
    .sort((a, b) => a.eta - b.eta)[0];
}

export function arcPath(from: LngLat, to: LngLat): [number, number, number][] {
  const d = distance(from, to);
  const height = Math.min(140, 25 + d * 0.35);
  return Array.from({length: 49}, (_, i) => {
    const t = i / 48;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, 4 * height * t * (1 - t) + 2];
  });
}

// Simulated history, shaped like the patterns in the feasibility brief: rack activity
// rising in the evening near racks, altercations late at night, person-down calls spread out.
// Replace with a geocoded DPS daily crime log at public/osm/history.json (see README).
export function simulatedHistory(buildings: Building[], racks: Rack[]): HistoryPoint[] {
  const random = rng(146);
  const campusBuildings = buildings.filter((b) => onCampus(b.position));
  const campusRacks = racks.filter((r) => onCampus(r.position));
  const north = campusBuildings.filter((b) => b.position[1] > 34.0235);
  const hourFrom = (weights: number[]) => {
    const total = weights.reduce((a, b) => a + b, 0);
    let x = random() * total;
    for (let h = 0; h < 24; h++) if ((x -= weights[h]) <= 0) return h;
    return 23;
  };
  const evening = Array.from({length: 24}, (_, h) => (h >= 16 && h <= 23 ? 6 : h >= 8 ? 2 : 0.6));
  const lateNight = Array.from({length: 24}, (_, h) => (h >= 21 || h <= 2 ? 7 : h >= 18 ? 2 : 0.4));
  const allDay = Array.from({length: 24}, (_, h) => (h >= 7 && h <= 23 ? 2 : 1));
  const points: HistoryPoint[] = [];
  const scatter = (around: LngLat, spread: number) => offset(around, (random() - 0.5) * spread, (random() - 0.5) * spread);
  for (let i = 0; i < 900; i++) {
    const rack = campusRacks[Math.floor(random() * campusRacks.length)];
    points.push({type: 'rack_activity', hour: hourFrom(evening), position: scatter(rack.position, 30)});
  }
  for (let i = 0; i < 380; i++) {
    const pool = random() < 0.7 && north.length ? north : campusBuildings;
    const b = pool[Math.floor(random() * pool.length)];
    points.push({type: 'altercation', hour: hourFrom(lateNight), position: scatter(b.position, 60)});
  }
  for (let i = 0; i < 320; i++) {
    const b = campusBuildings[Math.floor(random() * campusBuildings.length)];
    points.push({type: 'person_down', hour: hourFrom(allDay), position: scatter(b.position, 50)});
  }
  return points;
}

type Script = {type: IncidentType; severity: Severity; near: 'rack' | 'building'; place: string; observation: string; evidence: string[]; uncertainty: string; confidence: number};

// Staged events in the shape the Palladium cascade emits. Labelled "Demo" on screen.
const SCRIPTS: Script[] = [
  {type: 'rack_activity', severity: 'WATCH', near: 'rack', place: 'Kaprielian Hall',
    observation: 'person_4 stayed at the bike rack for 63 s, then a parked bicycle left the rack zone',
    evidence: ['person_4 stayed at the bike rack for 63 s, then a parked bicycle left the rack zone', 'crouched in 71% of samples at the rack'],
    uncertainty: 'Owners unlocking their own bicycles trigger this too. Ownership is not and cannot be determined.', confidence: 0.74},
  {type: 'person_down', severity: 'REVIEW_REQUIRED', near: 'building', place: 'Leavey Library',
    observation: 'person_2 lying horizontal with little movement for 14 s',
    evidence: ['person_2 lying horizontal with little movement for 14 s', 'horizontal in 100% of samples, drift 0.04 box diagonals', 'Verifier: frames show a person lying on the ground and not getting up'],
    uncertainty: 'Someone resting or sitting low can trigger this.', confidence: 0.88},
  {type: 'altercation', severity: 'HIGH_PRIORITY_REVIEW', near: 'building', place: 'Lyon Recreation Center',
    observation: 'person_1 and person_6 in close contact with rapid movement for 3.5 s',
    evidence: ['person_1 and person_6 in close contact with rapid movement for 3.5 s', '6 close fast-moving samples, mean pair motion 1.9 body heights/s', 'Verifier: two people appear to be shoving each other'],
    uncertainty: 'Play, sport or dancing can trigger this.', confidence: 0.82},
  {type: 'rack_activity', severity: 'WATCH', near: 'rack', place: 'Watt Hall',
    observation: 'person_9 stayed at the bike rack for 48 s, then a parked bicycle left the rack zone',
    evidence: ['person_9 stayed at the bike rack for 48 s, then a parked bicycle left the rack zone', 'crouched in 55% of samples at the rack'],
    uncertainty: 'Owners unlocking their own bicycles trigger this too. Ownership is not and cannot be determined.', confidence: 0.66},
  {type: 'person_down', severity: 'REVIEW_REQUIRED', near: 'building', place: 'Taper Hall',
    observation: 'person_3 lying horizontal with little movement for 11 s',
    evidence: ['person_3 lying horizontal with little movement for 11 s', 'horizontal in 92% of samples, drift 0.07 box diagonals'],
    uncertainty: 'Someone resting or sitting low can trigger this.', confidence: 0.79},
];

let demoCount = 2; // first staged incident is the altercation
const HEADINGS: Partial<Record<IncidentType, number>> = {altercation: 90, rack_activity: 180};
export function demoIncident(buildings: Building[], racks: Rack[], cameras: Camera[], variant: 'real' | 'benign' = 'real'): Incident {
  const script = variant === 'benign' ? SCRIPTS[2] : SCRIPTS[demoCount % SCRIPTS.length];
  if (variant !== 'benign') demoCount += 1; // a staged false alarm does not use up the script
  const building = buildings.find((b) => b.name.includes(script.place)) ?? buildings[0];
  const position = script.near === 'rack' ? nearest(racks, building.position)?.item.position ?? building.position
    : offset(building.position, 12, -10);
  const camera = nearest(cameras, position)?.item;
  return {id: `demo-${Date.now()}-${demoCount}`, type: script.type, severity: script.severity, position,
    place: building.name, cameraId: camera?.id ?? 'cam-?', createdAt: Date.now(), status: 'unreviewed',
    observation: script.observation, evidence: script.evidence, uncertainties: [script.uncertainty],
    confidence: script.confidence, origin: 'demo', variant, heading: variant === 'benign' ? undefined : HEADINGS[script.type]};
}
