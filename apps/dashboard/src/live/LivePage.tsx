// Live detection: main's real-time analysis workspace (MOSS live feed, phone pairing,
// uploads, review alerts and the pending-review queue), inside the dark Palladium shell.
import {useEffect, useRef, useState} from 'react';
import {AlertTriangle, ArrowUpRight, Clapperboard, Eye, Smartphone, Upload, X} from 'lucide-react';
import {QRCodeSVG} from 'qrcode.react';
import {Nav} from '../Nav';
import {Logo} from '../Logo';
import LiveMonitor from './LiveMonitor';
import IncidentQueue from './IncidentQueue';
import {updateIncidentQueue} from './incidentQueueState.mjs';
import './live.css';

type AnyRecord = Record<string, any>;
async function api(path: string, options: RequestInit = {}) {
  const r = await fetch('/api' + path, {credentials: 'same-origin', ...options});
  if (!r.ok) {
    let detail = 'Request failed';
    try { detail = (await r.json()).detail; } catch { /* non-JSON error */ }
    throw Object.assign(Error(typeof detail === 'string' ? detail : JSON.stringify(detail)), {status: r.status});
  }
  return r.json();
}
const post = (path: string, body: unknown) => api(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
const BUSY = ['streaming', 'processing', 'warming', 'waiting_for_gpu'];
// Incident review lives in the reviewer web app (served outside /command/); open it beside the live view.
const openIncident = (id: string) => window.open(`/review#incident=${encodeURIComponent(id)}`, '_blank', 'noopener');

export default function LivePage() {
  const [authed, setAuthed] = useState<boolean | null>(null), [token, setToken] = useState('');
  const [sources, setSources] = useState<AnyRecord[]>([]), [incidents, setIncidents] = useState<AnyRecord[]>([]), [health, setHealth] = useState<AnyRecord>({});
  const [pair, setPair] = useState(''), [error, setError] = useState(''), [uploading, setUploading] = useState(false), [connected, setConnected] = useState(false);
  const [bookmarkNotice, setBookmarkNotice] = useState(''), [warmNotice, setWarmNotice] = useState(''), [warming, setWarming] = useState(false);
  const [reviewAlert, setReviewAlert] = useState<AnyRecord | null>(null);
  const seen = useRef(new Set<string>()), eventConnected = useRef(false), sourceRevision = useRef(0), incidentRevision = useRef(0);

  const applyIncident = (incident: AnyRecord) => { incidentRevision.current++; seen.current.add(incident.id); setIncidents((old) => updateIncidentQueue(old, incident)); };
  const refresh = async () => {
    const revision = sourceRevision.current, incidentVersion = incidentRevision.current;
    try {
      const [s, i, h] = await Promise.all([api('/sources'), api('/incidents'), api('/health')]);
      i.forEach((incident: AnyRecord) => seen.current.add(incident.id));
      setSources((old) => revision === sourceRevision.current ? s : [...old, ...s.filter((x: AnyRecord) => !old.some((o) => o.id === x.id))]);
      if (incidentVersion === incidentRevision.current) setIncidents(i);
      setHealth(h); setAuthed(true);
    } catch (e: any) { if (e.status === 401) setAuthed(false); else { setConnected(false); setAuthed((a) => a ?? false); } }
  };
  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!authed) return;
    let ws: WebSocket, retry = 0, stopped = false;
    const connect = () => {
      ws = new WebSocket(wsUrl('/ws/events'));
      ws.onopen = () => { eventConnected.current = true; setConnected(true); void refresh(); };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === 'source') { sourceRevision.current++; setSources((old) => [m.payload, ...old.filter((s) => s.id !== m.payload.id)]); }
        if (m.type === 'incident') {
          if (!m.payload.record?.queue_deleted?.active && !seen.current.has(m.payload.id)) {
            seen.current.add(m.payload.id); setReviewAlert(m.payload);
            if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
              const notice = new Notification(m.payload.record?.trigger_origin === 'reviewer' ? 'Palladium · Marked moment saved' : 'Palladium · Review requested', {body: 'A possible safety event has supporting footage. Open the original clip and assess the context.', tag: m.payload.id});
              notice.onclick = () => { window.focus(); openIncident(m.payload.id); setReviewAlert(null); notice.close(); };
            }
          }
          applyIncident(m.payload);
        }
        if (m.type === 'job' && ['completed', 'failed', 'queued', 'running'].includes(m.payload.status)) {
          const version = incidentRevision.current;
          api('/incidents').then((list) => { if (version === incidentRevision.current) setIncidents(list); }).catch(() => {});
        }
      };
      ws.onclose = () => { eventConnected.current = false; setConnected(false); if (!stopped) retry = window.setTimeout(connect, 2000); };
    };
    connect();
    const poll = setInterval(() => { if (eventConnected.current) api('/health').then(setHealth).catch(() => {}); else void refresh(); }, 2500);
    return () => { stopped = true; eventConnected.current = false; clearInterval(poll); clearTimeout(retry); ws?.close(); };
  }, [authed]);

  const source = sources.find((s) => BUSY.includes(s.status)) || sources[0];
  const pending = incidents.filter((i) => ['pending', 'needs_review'].includes(i.review_status) && !i.record?.queue_deleted?.active);
  const sourceBusy = sources.some((s) => BUSY.includes(s.status));

  async function prepareLiveModels() {
    if (warming || health.streaming_model !== 'moss') return;
    setWarming(true); setWarmNotice('Preparing MOSS and visual verification before capture…');
    try { await post('/models/moss/warm', {}); setWarmNotice('Live models ready · camera capture can begin.'); void refresh(); }
    catch (e: any) { setWarmNotice(e.status === 409 ? 'Live analysis is already using the GPU.' : `Model preparation needs attention: ${e.message}`); }
    finally { setWarming(false); }
  }
  async function pairPhone() {
    if (!sourceBusy) void prepareLiveModels();
    try {
      setError('');
      const r = await post('/sources', {name: 'Mobile camera', kind: 'phone'});
      const capture = new URL('/capture', window.location.origin);
      capture.hash = new URL(r.capture_url, window.location.origin).hash;
      setPair(capture.href); void refresh();
    } catch (e) { setError(String(e)); }
  }
  async function upload(file: File) {
    setUploading(true); setError('');
    try { const body = new FormData(); body.append('file', file); await api('/upload', {method: 'POST', body}); void refresh(); }
    catch (e) { setError(String(e)); } finally { setUploading(false); }
  }
  async function markMoment(sourceId: string) {
    try { await post(`/sources/${sourceId}/bookmark`, {}); setBookmarkNotice('Moment marked. Surrounding footage will appear for review after its context is saved.'); }
    catch (e) { setError(String(e)); }
  }

  const header = (
    <header className="strip">
      <Nav active="live" />
      <div className="chips">
        <div className="chip"><span className="chip-label">Backend</span><strong>{connected ? 'Connected' : authed === false ? 'Sign in' : 'Reconnecting'}</strong></div>
        {authed && <div className="chip"><span className="chip-label">Awaiting review</span><strong>{pending.length}</strong></div>}
      </div>
    </header>
  );

  if (authed === null) return <>{header}<main className="live-page"><div className="live-wrap"><section className="lv-panel" role="status">Connecting to the live workspace…</section></div></main></>;
  if (!authed) return <>{header}<main className="live-page"><div className="live-wrap"><div className="login">
    <div className="brand"><Logo variant="mark" size={44} /><strong>Palladium</strong></div>
    <span className="eyebrow">Live detection</span><h1>A second set of eyes.</h1>
    <p>Sign in to the review workspace to watch the live feed, see MOSS observations and review flagged moments.</p>
    <form onSubmit={async (e) => { e.preventDefault(); try { setError(''); await post('/login', {token}); void refresh(); } catch (err) { setError(String(err)); } }}>
      <label htmlFor="live-token">Workspace access token</label>
      <input id="live-token" type="password" autoComplete="current-password" placeholder="Enter your access token" value={token} onChange={(e) => setToken(e.target.value)} />
      <button className="primary">Open live workspace <ArrowUpRight size={17} /></button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    <small>Authorized reviewer access · audio is off · human decisions</small>
  </div></div></main></>;

  return <>
    {header}
    <main className="live-page">
      <div className="live-wrap">
        {error && <div className="error" role="alert">{error}<button className="text-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}
        {health.verifier_research_mode && <details className="research-note"><summary>Research model · human review required</summary><p>Owner-approved staged research candidate. Scores are uncalibrated; human review is required.</p></details>}
        {health.simulated && <div className="simulation">Simulated development mode · fixture alerts are not real model results.</div>}
        {reviewAlert && <div className="review-notification" role="status"><AlertTriangle size={20} /><div><strong>{reviewAlert.record?.trigger_origin === 'reviewer' ? 'Marked moment saved' : 'Possible incident · review required'}</strong><p>Original footage and context are ready for a closer look.</p></div><button onClick={() => { openIncident(reviewAlert.id); setReviewAlert(null); }}>Review footage <ArrowUpRight size={15} /></button><button className="text-button" aria-label="Dismiss notification" onClick={() => setReviewAlert(null)}><X size={16} /></button></div>}

        <div className="page-heading"><div><span className="eyebrow">Real-time video analysis</span><h1>A second set of eyes.</h1><p>Watch the scene. See the observations. Review the original context.</p></div>
          <div className="page-actions">
            <a className="button" href="#/live/demo" title="Stage a simulated incident or false alarm on the 3D campus view"><Clapperboard size={15} />Stage demo</a>
            <label className="button"><Upload size={15} />{uploading ? 'Uploading…' : 'Upload recording'}<input hidden type="file" accept="video/mp4,video/quicktime,video/webm" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} /></label>
            <button className="primary" onClick={pairPhone}><Smartphone size={16} />Pair phone camera</button>
          </div>
        </div>

        <div className="live-status-strip">
          <span><i className={'dot ' + (source?.status === 'streaming' ? 'green' : '')} />{source?.status === 'streaming' ? 'Receiving video' : source?.status === 'processing' ? 'Finishing analysis' : 'Ready for a source'}</span>
          <span>{pending.length} awaiting review</span>
          <span>{health.streaming_model === 'moss' ? 'MOSS-VL + visual verification' : health.streaming_model || 'Checking inference'}</span>
          <span>1 active source capacity</span>
        </div>
        <div id="live-monitor"><LiveMonitor source={source} onPair={pairPhone} onUpload={(file) => void upload(file)} onOpen={openIncident} /></div>
        {source?.status === 'streaming' && <div className="live-actions"><button onClick={() => markMoment(source.id)}><Eye size={15} />Mark moment for review</button><span className="fine">Preserve the surrounding original context.</span></div>}
        {bookmarkNotice && <p className="fine" role="status">{bookmarkNotice}</p>}
        {health.streaming_model === 'moss' && warmNotice && <p className="fine" role="status">{warmNotice}</p>}

        <div className="live-queue-heading"><span>Pending human review</span><a className="text-button" href="#/incidents">All incidents <ArrowUpRight size={14} /></a></div>
        <IncidentQueue incidents={pending.slice(0, 4)} compact onOpen={openIncident} onChange={applyIncident} />
        <footer className="app-footer"><span><Logo variant="mark" size={17} />Palladium · Live detection</span><span>AI observes. People decide.</span></footer>
      </div>
    {pair && <div className="modal-backdrop" onClick={() => setPair('')}><section className="pair-modal" role="dialog" aria-modal="true" aria-labelledby="pair-title" onClick={(e) => e.stopPropagation()}>
      <button className="close" onClick={() => setPair('')} aria-label="Close pairing"><X /></button>
      <Logo variant="mark" size={43} /><h2 id="pair-title">Bring your phone into view.</h2>
      <p>Scan, test phone alerts, allow camera access, then tap Start camera.</p>
      {warmNotice && <p className="fine" role="status">{warmNotice}</p>}
      <div className="qr"><QRCodeSVG value={pair} size={210} /></div>
      <input readOnly aria-label="Phone pairing URL" value={pair} />
      <button className="primary wide" onClick={() => navigator.clipboard.writeText(pair)}>Copy pairing link</button>
      <p className="fine">Link expires in one hour. HTTPS is required on your phone. Keep capture open. Location is optional; turn off Share camera location to stream without it.</p>
    </section></div>}
    </main>
  </>;
}
