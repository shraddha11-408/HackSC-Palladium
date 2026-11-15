import React,{useState,useEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Activity,ArrowUpRight,Bell,Camera,Check,ChevronLeft,Clock,Eye,FileVideo,Layers,Lock,Radio,Shield,Smartphone,Upload,X,Sun,AlertTriangle,MapPin,BookOpen} from 'lucide-react';
import {QRCodeSVG} from 'qrcode.react';
import './style.css';
import LiveMonitor from './LiveMonitor';
import {publishLiveVideo} from './liveVideo';
import {recordEvidence,type RecordingHandle} from './nativeRecording';
import {shareCameraLocation,type CameraLocationState} from './geolocation';
import ReviewPage from './IncidentReview';
import StorageStatus from './StorageStatus';
import IncidentQueue from './IncidentQueue';
import LearningRepository,{LearningPermission} from './LearningRepository';
const ActivityMap=React.lazy(()=>import('./ActivityMap'));

type AnyRecord=Record<string,any>;
async function api(path:string,options:RequestInit={}){
  const r=await fetch('/api'+path,options);
  if(!r.ok){let detail='Request failed';try{detail=(await r.json()).detail}catch{}throw Object.assign(Error(typeof detail==='string'?detail:JSON.stringify(detail)),{status:r.status})}return r.json();
}
const post=(path:string,body:unknown)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const wsUrl=(path:string)=>`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${path}`;
const media=(id:string,kind:string)=>`/api/incidents/${id}/media/${kind}`;

function Capture(){
  const video=useRef<HTMLVideoElement>(null),socket=useRef<WebSocket|null>(null),stream=useRef<MediaStream|null>(null),timer=useRef<number>(0),running=useRef(false),wake=useRef<any>(null),liveVideo=useRef<(()=>void)|null>(null),recording=useRef<RecordingHandle|null>(null),locationShare=useRef<(()=>void)|null>(null),locationEnabled=useRef(false),captureReady=useRef(false),locationSupported=useRef(false);
  const [status,setStatus]=useState('Ready to connect'),[frames,setFrames]=useState(0),[error,setError]=useState(''),[active,setActive]=useState(false),[facing,setFacing]=useState('environment'),[quality,setQuality]=useState('fast'),[captureInfo,setCaptureInfo]=useState(''),[liveStatus,setLiveStatus]=useState(''),[recordingStatus,setRecordingStatus]=useState(''),[shareLocation,setShareLocation]=useState(false),[locationState,setLocationState]=useState<CameraLocationState|null>(null),[locationAck,setLocationAck]=useState('');
  function startLocation(){const ws=socket.current;if(!locationEnabled.current||!captureReady.current||!ws||ws.readyState!==WebSocket.OPEN)return;if(!locationSupported.current){setLocationState({status:'unavailable',message:'This server does not support geotagging yet. Camera video continues.'});return}locationShare.current?.();setLocationAck('');locationShare.current=shareCameraLocation(message=>{if(ws===socket.current&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message))},setLocationState)}
  function toggleLocation(enabled:boolean){locationEnabled.current=enabled;setShareLocation(enabled);locationShare.current?.();locationShare.current=null;setLocationState(null);setLocationAck('');if(enabled)startLocation()}
  const stop=async()=>{locationShare.current?.();locationShare.current=null;captureReady.current=false;locationSupported.current=false;setLocationState(null);setLocationAck('');running.current=false;clearTimeout(timer.current);const ws=socket.current;socket.current=null;liveVideo.current?.();liveVideo.current=null;const native=recording.current;recording.current=null;const flushed=native?.stop();stream.current?.getTracks().forEach(t=>t.stop());wake.current?.release();setActive(false);await flushed;if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'stop'}));else ws?.close()};
  useEffect(()=>()=>{void stop()},[]);
  async function start(){
    await stop();setError('');setStatus('Opening camera…');
    try{
      if(!window.isSecureContext)throw Error('Camera access needs HTTPS. Open the secure pairing URL from the dashboard.');
      if(!navigator.mediaDevices?.getUserMedia)throw Error('This browser does not support camera capture. Use Safari or Chrome.');
      const token=location.hash.slice(1);if(!token)throw Error('Open the pairing link from the Palladium dashboard first.');
      stream.current=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60,max:60}},audio:false});
      const camera=stream.current.getVideoTracks()[0];
      const actual=camera.getSettings();setCaptureInfo(`${actual.width||'?'} × ${actual.height||'?'} · ${actual.frameRate?.toFixed(0)||'?'} capture FPS`);
      video.current!.srcObject=stream.current;await video.current!.play();
      liveVideo.current=publishLiveVideo(stream.current,token,setLiveStatus);
      const ws=new WebSocket(wsUrl('/ws/capture'));socket.current=ws;running.current=true;setActive(true);
      const canvas=document.createElement('canvas');let fps=12,encoding=false,inFlight=0;
      const send=()=>{
        if(!running.current||ws!==socket.current||ws.readyState!==WebSocket.OPEN)return;
        timer.current=window.setTimeout(send,1000/fps);
        if(encoding||inFlight>=2||ws.bufferedAmount>512*1024)return;
        const v=video.current!;if(!v.videoWidth)return;
        const ratio=Math.min(1,(quality==='fast'?960:1280)/Math.max(v.videoWidth,v.videoHeight));canvas.width=Math.floor(v.videoWidth*ratio/2)*2;canvas.height=Math.floor(v.videoHeight*ratio/2)*2;
        canvas.getContext('2d')!.drawImage(v,0,0,canvas.width,canvas.height);encoding=true;
        const timestamp=performance.now()/1000;
        canvas.toBlob(async blob=>{try{if(!blob||!running.current||ws!==socket.current||ws.readyState!==WebSocket.OPEN)return;
          const bytes=await blob.arrayBuffer();if(ws.readyState!==WebSocket.OPEN)return;
          inFlight++;ws.send(JSON.stringify({type:'frame',timestamp}));ws.send(bytes);
        }finally{encoding=false}},'image/jpeg',quality==='fast'?.72:.85);
      };
      ws.onopen=()=>{setStatus('Pairing with Palladium…');ws.send(JSON.stringify({token,native_recording:typeof MediaRecorder!=='undefined'}))};
      ws.onmessage=e=>{if(ws!==socket.current)return;const m=JSON.parse(e.data);if(m.type==='ready'){captureReady.current=true;locationSupported.current=m.geolocation===true;startLocation();fps=Math.min(m.fps,quality==='fast'?12:8);setStatus('Connected · streaming');if(m.native_recording)recording.current=recordEvidence(stream.current!,m.source_id,token,setRecordingStatus);else setRecordingStatus('Evidence clips use sampled frames · smooth native recording is not enabled');send()}
        if(m.type==='geolocation'){setLocationAck(m.accepted&&m.status==='active'?'Location shared with the reviewer':m.status==='disabled'?'Location sharing is off.':m.reason==='rate_limited'?'Waiting to share the next location fix.':m.reason&&m.reason!=='unchanged'?'Location was not accepted yet; waiting for a fresh fix.':'');return}
        if(m.type==='ack'){inFlight=Math.max(0,inFlight-1);setFrames(m.index);setStatus(m.model_status==='error'?'Streaming · model unavailable':m.model_status==='waiting_for_gpu'?'Streaming · analysis queued':m.model_status==='loading'?'Streaming · analysis starting':'Connected · streaming')}
        if(m.type==='error'){setError(m.message);stop()}};
      ws.onclose=e=>{if(ws===socket.current&&running.current){setStatus('Disconnected');setError(e.reason||'Connection closed. Tap Start camera to reconnect.');stop()}};
      ws.onerror=()=>setError('Unable to reach server. Check your connection and secure pairing URL.');
      try{wake.current=await (navigator as any).wakeLock?.request('screen')}catch{}
    }catch(e){setError(String(e));stop();setStatus('Not connected')}
  }
  return <div className="capture-page"><div className="brand"><Shield size={26}/><strong>Palladium</strong><small>CAMERA LINK</small></div><h1>Your phone.<br/>A clearer view.</h1><p>Secure camera link to your Palladium review workspace. Audio is off.</p>
    <div className="phone-preview"><video ref={video} autoPlay playsInline muted/>{!active&&<Camera size={48}/>}<span className="phone-status"><i className={active?'dot green':'dot'}/>{status}</span></div>
    <div className="capture-stats"><span>{frames} evidence frames acknowledged</span><span>{captureInfo||`${facing==='environment'?'Rear':'Front'} camera · target 1080p / 60 FPS`}</span></div>
    {liveStatus&&<p className="fine" role="status">{liveStatus}</p>}{recordingStatus&&<p className="fine" role="status">{recordingStatus}</p>}
    <section className="camera-location"><label><input type="checkbox" checked={shareLocation} onChange={e=>toggleLocation(e.target.checked)}/><span>Share camera location<small>Optional. Location and its accuracy can be saved with incidents. This does not identify an exact address.</small></span></label><p role="status">{active&&locationState?<>{locationState.message}{locationState.status==='active'&&locationAck&&<span>{locationAck}</span>}</>:shareLocation?'Location will be requested after the camera connects.':'Location sharing is off.'}</p></section>
    {error&&<div className="error" role="alert">{error}</div>}
    {!active?<><select aria-label="Camera" value={facing} onChange={e=>setFacing(e.target.value)}><option value="environment">Rear camera</option><option value="user">Front camera</option></select><select aria-label="Analysis sample quality" value={quality} onChange={e=>setQuality(e.target.value)}><option value="fast">Analysis samples · 960px · up to 12 FPS</option><option value="detail">Analysis samples · 1280px · up to 8 FPS</option></select><button className="primary wide" onClick={start}><Camera size={18}/>Start camera</button></>:<button className="danger wide" onClick={stop}>Stop streaming</button>}
    <p className="fine">The dashboard receives the camera video directly with a 1080p / 60 FPS target. Actual quality depends on device and network. When enabled on the server and supported by this browser, native recording preserves smoother new incident clips. The recording status above shows which mode is active; otherwise saved clips use the sampled evidence frames. Keep this page open and the phone awake. Landscape gives the clearest event view. Works over Wi-Fi or cellular. If the connection drops, reconnect here; a new stream starts at zero.</p></div>
}


function incidentFromLocation(){const id=new URLSearchParams(location.hash.slice(1)).get('incident');return id&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)?id:null}
function App(){
  const [bookmarkNotice,setBookmarkNotice]=useState('');
  const seenIncidents=useRef(new Set<string>()),eventConnected=useRef(false),sourceRevision=useRef(0);
  const [reviewAlert,setReviewAlert]=useState<AnyRecord|null>(null),[notificationPermission,setNotificationPermission]=useState('Notification' in window?Notification.permission:'unavailable');
  const [authed,setAuthed]=useState(false),[token,setToken]=useState(''),[sources,setSources]=useState<AnyRecord[]>([]),[incidents,setIncidents]=useState<AnyRecord[]>([]),[health,setHealth]=useState<AnyRecord>({}),[selected,setSelected]=useState<string|null>(incidentFromLocation),[pair,setPair]=useState(''),[error,setError]=useState(''),[uploading,setUploading]=useState(false),[connected,setConnected]=useState(false),[tab,setTab]=useState(location.hash==='#learning'?'Learning repository':location.hash==='#activity'?'Campus activity':'Overview');
  const refresh=async()=>{const revision=sourceRevision.current;try{const [s,i,h]=await Promise.all([api('/sources'),api('/incidents'),api('/health')]);i.forEach((incident:AnyRecord)=>seenIncidents.current.add(incident.id));setSources(old=>revision===sourceRevision.current?s:[...old,...s.filter((source:AnyRecord)=>!old.some(item=>item.id===source.id))]);setIncidents(i);setHealth(h);setAuthed(true)}catch(e:any){if(e.status===401)setAuthed(false);else setConnected(false)}};
  useEffect(()=>{refresh()},[]);
  useEffect(()=>{const navigate=()=>{setSelected(incidentFromLocation());if(location.hash==='#learning')setTab('Learning repository');else if(location.hash==='#activity')setTab('Campus activity')};window.addEventListener('hashchange',navigate);return()=>window.removeEventListener('hashchange',navigate)},[]);
  useEffect(()=>{if(!authed)return;let ws:WebSocket;let retry:number;let stopped=false;
    const connect=()=>{ws=new WebSocket(wsUrl('/ws/events'));ws.onopen=()=>{eventConnected.current=true;setConnected(true);refresh()};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='source'){sourceRevision.current++;setSources(old=>[m.payload,...old.filter(s=>s.id!==m.payload.id)])};if(m.type==='incident'){
      if(!seenIncidents.current.has(m.payload.id)){
        seenIncidents.current.add(m.payload.id);setReviewAlert(m.payload);
        if('Notification' in window&&Notification.permission==='granted'&&document.hidden){
          const notice=new Notification(m.payload.record?.trigger_origin==='reviewer'?'Palladium · Marked moment saved':'Palladium · Review requested',{body:'A possible safety event has supporting footage. Open the original clip and assess the context.',tag:m.payload.id});
          notice.onclick=()=>{window.focus();setSelected(m.payload.id);setReviewAlert(null);notice.close()};
        }
      }
      setIncidents(old=>[m.payload,...old.filter(i=>i.id!==m.payload.id)])
    }if(m.type==='job'&&['completed','failed','queued','running'].includes(m.payload.status)){api('/incidents').then(setIncidents).catch(()=>{})}};ws.onclose=()=>{eventConnected.current=false;setConnected(false);if(!stopped)retry=window.setTimeout(connect,2000)}};connect();
    const poll=setInterval(()=>{if(eventConnected.current)api('/health').then(setHealth).catch(()=>{});else refresh()},2500);return()=>{stopped=true;eventConnected.current=false;clearInterval(poll);clearTimeout(retry);ws?.close()};
  },[authed]);
  async function pairPhone(){try{setError('');const r=await post('/sources',{name:'Mobile camera',kind:'phone'});const capture=new URL('/capture',window.location.origin);capture.hash=new URL(r.capture_url,window.location.origin).hash;setPair(capture.href);refresh()}catch(e){setError(String(e))}}
  async function upload(file:File){setUploading(true);setError('');try{const body=new FormData();body.append('file',file);await api('/upload',{method:'POST',body});refresh()}catch(e){setError(String(e))}finally{setUploading(false)}}
  async function markMoment(sourceId:string){try{await post(`/sources/${sourceId}/bookmark`,{});setBookmarkNotice('Moment marked. Surrounding footage will appear for review after its context is saved.')}catch(e){setError(String(e))}}
  async function exportFeedback(){try{const data=await api('/reviews/export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='safesc-review-history.json';link.click();URL.revokeObjectURL(url)}catch(e){setError(String(e))}}
  if(!authed)return <div className="login"><div className="brand"><Shield/><strong>Palladium</strong></div><span className="eyebrow">AUTHORIZED REVIEW WORKSPACE</span><h1>A clearer view.<br/>A human decision.</h1><p>Enter your workspace access token to continue.</p><form onSubmit={async e=>{e.preventDefault();try{await post('/login',{token});refresh()}catch(e){setError(String(e))}}}><input type="password" autoComplete="current-password" aria-label="Workspace access token" placeholder="Workspace access token" value={token} onChange={e=>setToken(e.target.value)}/><button className="primary">Open workspace <ArrowUpRight size={18}/></button></form>{error&&<p className="error">{error}</p>}<small>Access token: data/app_token on the server</small></div>;
  const source=sources.find(s=>s.status==='streaming')||sources[0],pending=incidents.filter(i=>i.review_status==='pending').length;
  return <div className="shell"><aside><div className="brand"><Shield size={27}/><strong>Palladium</strong></div><div className="workspace"><i className="dot green"/><div>Campus safety lab<small>HUMAN REVIEW WORKSPACE</small></div></div><span className="nav-label">WORKSPACE</span>{[['Overview',Activity],['Live monitor',Radio],['Incident queue',Layers],['Campus activity',MapPin],['Learning repository',BookOpen],['Privacy & controls',Lock]].map(([label,Icon]:any)=><button key={label} className={'nav '+(tab===label?'active':'')} onClick={()=>{setTab(label);setSelected(null);history.replaceState(null,'',label==='Learning repository'?'#learning':label==='Campus activity'?'#activity':location.pathname+location.search)}}><Icon size={18}/>{label}{label==='Incident queue'&&pending>0&&<b>{pending}</b>}</button>)}<div className="sidebar-bottom"><Shield size={20}/><p>AI observes.<br/><strong>People decide.</strong></p><small>No identity recognition.<br/>No automatic dispatch.</small></div></aside>
    <div className="main"><header><span>Workspace <span className="slash">/</span> {selected?'Incident review':tab}</span><div>{notificationPermission!=='unavailable'&&<button className="text-button" title="Notify this reviewer while the workspace is open. No campus-wide alerts are sent." onClick={async()=>{setNotificationPermission(await Notification.requestPermission())}}><Bell size={16}/>{notificationPermission==='granted'?'Review alerts on':'Enable review alerts'}</button>}<i className={'dot '+(connected?'green':'')}/>{connected?'Workspace connected':'Reconnecting'}<span className="avatar">SC</span></div></header><main>
    {reviewAlert&&<div className="review-notification" role="status"><AlertTriangle size={20}/><div><strong>{reviewAlert.record?.trigger_origin==='reviewer'?'Marked moment saved · review required':'Possible incident · review required'}</strong><p>Open the original footage, assess the uncertainty, then confirm or dismiss.</p></div><button onClick={()=>{setSelected(reviewAlert.id);setReviewAlert(null)}}>Review footage <ArrowUpRight size={16}/></button><button className="text-button" aria-label="Dismiss notification" onClick={()=>setReviewAlert(null)}><X size={16}/></button></div>}
    {selected?<ReviewPage id={selected} onBack={()=>setSelected(null)}/>:tab==='Learning repository'?<React.Suspense fallback={<p>Loading learning repository…</p>}><LearningRepository onReturnToLive={()=>{setTab('Live monitor');setSelected(null);history.replaceState(null,'',location.pathname+location.search)}}/></React.Suspense>:tab==='Campus activity'?<React.Suspense fallback={<p>Loading campus activity…</p>}><ActivityMap/></React.Suspense>:<><div className="page-heading"><div><span className="eyebrow">SAFETY, WITH CONTEXT</span><h1>{tab==='Privacy & controls'?'Trust is part of the system.':tab==='Incident queue'?'The moments worth a closer look.':'A clearer view of campus.'}</h1><p>Observable events. Preserved context. Human decisions.</p></div><button onClick={pairPhone}><Smartphone size={17}/>Connect phone</button></div>
    {error&&<div className="error" role="alert">{error}</div>}{health.verifier_research_mode&&<div className="simulation">HIGH-RECALL RESEARCH CANDIDATE · Owner-approved staged demo · Human review required. See Learning repository for measured misses and false alerts.</div>}{health.simulated&&<div className="simulation">SIMULATED DEVELOPMENT MODE · Fixture alerts are not real model results.</div>}
    {source?.status==='streaming'&&<div className="live-actions"><button onClick={()=>markMoment(source.id)}><Eye size={16}/>Mark moment for review</button><span className="fine">Save context when you see something that deserves a closer look.</span></div>}
    {bookmarkNotice&&<p className="fine" role="status">{bookmarkNotice}</p>}
    {tab==='Privacy & controls'&&<p><button onClick={exportFeedback}>Export review history</button><span className="fine"> Reviewer feedback is auditable. Model training requires a separate evaluated release.</span></p>}
    {tab==='Privacy & controls'?<><StorageStatus/><div className="controls-grid">{[['Originals preserved','Untouched uploads and hashed incident windows are stored separately from generated review copies.'],['People stay anonymous','Only temporary person labels are used. Identity and demographic inference are excluded.'],['Human review required','Confirm, dismiss or request more review. No external dispatch occurs.'],['Short retention',`Incident media expires after ${health.retention_hours||24} hours unless kept for recall. Reviewer decisions remain auditable.`],['Honest processing','Unavailable models report errors. Fixtures and enhanced videos carry visible labels.'],['Secure phone capture','Pairing links expire in one hour. Camera capture requires HTTPS; audio stays off.']].map(([title,copy])=><section className="panel" key={title}><Lock size={20}/><h3>{title}</h3><p>{copy}</p></section>)}</div></>:<>
    <div className="stats"><div><span>Connected sources</span><strong>{sources.filter(s=>s.status==='streaming').length}<small> / 1</small></strong><p><i className="dot green"/>Shared GPU pipeline</p></div><div><span>Awaiting review</span><strong>{pending.toString().padStart(2,'0')}</strong><p>Human attention required</p></div><div><span>Inference engine</span><strong className="model-name">{health.streaming_model==='moss'?'MOSS-VL':health.streaming_model||'—'}</strong><p>{health.gpu?.[0]||'GPU not connected'}</p></div><div><span>Evidence integrity</span><strong className="model-name">SHA-256</strong><p><Lock size={12}/>Original windows hashed</p></div></div>
    {tab!=='Incident queue'&&<LiveMonitor source={source} onPair={pairPhone} onUpload={upload} onOpen={setSelected}/>}
    <IncidentQueue incidents={incidents} onOpen={setSelected} uploading={uploading}/></>}
    </>}
    <footer><Shield size={14}/>Palladium is a human decision-support prototype.<span>Built for Trojans, by Trojans.</span></footer></main></div>
    {pair&&<div className="modal-backdrop" onClick={()=>setPair('')}><section className="pair-modal" onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setPair('')} aria-label="Close pairing"><X/></button><Smartphone size={30}/><h2>Bring your phone into view.</h2><p>Scan with your phone camera. Open the link, allow camera access, then tap Start camera.</p><div className="qr"><QRCodeSVG value={pair} size={210}/></div><input readOnly aria-label="Phone pairing URL" value={pair}/><button className="primary wide" onClick={()=>navigator.clipboard.writeText(pair)}>Copy pairing link</button><p className="fine">Link expires in 1 hour. HTTPS is required on your phone. Keep the capture page open. Camera location is optional and starts only if you enable it on the phone.</p></section></div>}</div>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>{location.pathname==='/capture'?<Capture/>:<App/>}</React.StrictMode>);
