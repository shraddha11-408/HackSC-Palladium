// Messages between the command dashboard and officer phones.
// Transport: the Palladium relay (/ws/dispatch/{room}) when the API is reachable, so phones on
// another device work; always also a BroadcastChannel, so tabs on the same machine work offline.
import type {LngLat, Priority, UnitStatus} from './types';

export type Assignment = {
  dispatchId: string;
  incidentId: string;
  label: string;
  severity: string;
  priority: Priority;
  place: string;
  address?: string;
  floors?: string;
  observation: string;
  reason: string;
  support: string[];
  position: LngLat;
  partners: string[];
  assignedAt: number;
  message?: string; // outreach written by the dispatch agent for this unit
  urgency?: string;
};

export type BusMessage =
  | {type: 'hello'; unitId: string}
  | {type: 'presence'; unitId: string}
  | {type: 'state'; unitId: string; callsign: string; status: UnitStatus; assignment: Assignment | null; etaSeconds?: number}
  | {type: 'ack' | 'arrived' | 'clear'; unitId: string; dispatchId: string}
  | {type: 'alert'; alert: AlertMsg};

// Geofenced safety alert (or all-clear) broadcast to student phones; each phone decides if it is inside.
export type AlertMsg = {
  id: string; kind: 'alert' | 'clear'; title: string; message: string; center: LngLat; radius: number;
  at: number; place: string; incidentType: string;
};

export function newRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function dashboardRoom() {
  try {
    const existing = localStorage.getItem('safesc-dispatch-room');
    if (existing) return existing;
    const room = newRoom();
    localStorage.setItem('safesc-dispatch-room', room);
    return room;
  } catch {
    return newRoom();
  }
}

export type Bus = {send: (m: BusMessage) => void; close: () => void; relay: () => boolean};

export function openBus(room: string, onMessage: (m: BusMessage) => void): Bus {
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(`safesc-dispatch-${room}`) : null;
  if (channel) channel.onmessage = (e) => onMessage(e.data as BusMessage);
  let socket: WebSocket | null = null, closed = false, retry = 0, relayUp = false;
  const queue: string[] = [];
  const connect = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/dispatch/${room}`);
    socket.onopen = () => {relayUp = true; retry = 0; while (queue.length) socket?.send(queue.shift()!);};
    socket.onmessage = (e) => {try {onMessage(JSON.parse(e.data));} catch { /* ignore malformed */ }};
    socket.onclose = () => {
      relayUp = false;
      if (!closed) setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
    };
  };
  connect();
  return {
    send: (m) => {
      channel?.postMessage(m);
      const text = JSON.stringify(m);
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(text);
      else if (queue.length < 50) queue.push(text);
    },
    close: () => {closed = true; channel?.close(); socket?.close();},
    relay: () => relayUp,
  };
}

export function officerLink(room: string, unitId: string) {
  return `${location.origin}${location.pathname}?unit=${encodeURIComponent(unitId)}&room=${encodeURIComponent(room)}`;
}
