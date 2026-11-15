import React, {Suspense, lazy, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {setWorkerUrl} from 'maplibre-gl';
// MapLibre 6 loads its worker as an ES module next to a shared chunk; Vite's dependency
// pre-bundling breaks that relative path, so let Vite bundle the worker and hand over its URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import './dispatch.css';
import './agent.css';
import './pages.css';
import {useRoute} from './Nav';
import './command.css';
import './unslop.css';

setWorkerUrl(maplibreWorkerUrl);

const Trends = lazy(() => import('./Trends'));
const Incidents = lazy(() => import('./Incidents'));
const About = lazy(() => import('./About'));
const Live = lazy(() => import('./App'));
// The Live detection tab is main's real-time analysis workspace (MOSS feed, phone pairing, review queue).
const LiveDetection = lazy(() => import('./live/LivePage'));
const OfficerView = lazy(() => import('./Officer'));
const StudentApp = lazy(() => import('./StudentApp'));

// Pages live behind the hash (#/trends, #/incidents, #/live, #/about) so the static gateway needs no routes.
// ?unit=...&room=... opens the officer phone view; ?app=1&room=... opens the student alert app.
// #/live/demo opens the staged demo (the previous Live detection view) under the same tab.
function useStageDemo() {
  const read = () => /^#\/?live\/demo\b/.test(location.hash);
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return on;
}

function Root() {
  const params = new URLSearchParams(location.search);
  const route = useRoute();
  const stageDemo = useStageDemo();
  const unit = params.get('unit'), room = params.get('room');
  let page: React.ReactNode;
  const embedded = params.get('embedded') === '1';
  if (unit && room) page = <OfficerView unitId={unit} room={room} />;
  else if (embedded) page = <Live embedded />;
  else if (params.get('app')) {
    let saved = '';
    try {saved = localStorage.getItem('safesc-dispatch-room') ?? '';} catch { /* storage blocked */ }
    page = <StudentApp room={room ?? saved} />;
  } else page = route === 'live' ? (stageDemo ? <Live embedded={false} /> : <LiveDetection />) : route === 'incidents' ? <Incidents /> : route === 'about' ? <About /> : <Trends />;
  return <Suspense fallback={<div className="boot"><i />Loading Palladium…</div>}>{page}</Suspense>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
