import {useEffect,useRef,useState} from 'react';
import {receiveLiveVideo,hasDecodedVideo,type LiveMetrics} from './liveVideo';
import CameraLocation from './CameraLocation';
import {Camera,Smartphone,Upload,Radio,Eye,Sun,Clock,Activity,MessageSquare,AlertTriangle,LoaderCircle} from 'lucide-react';
type Data=Record<string,any>;
const socketUrl=(path:string)=>`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${path}`;
const clock=(n:number)=>`${Math.floor(Math.max(0,n)/60)}:${String(Math.floor(Math.max(0,n)%60)).padStart(2,'0')}`;
async function decode(data:Blob):Promise<ImageBitmap|HTMLImageElement>{
  if('createImageBitmap' in window)return createImageBitmap(data);
  return new Promise((resolve,reject)=>{const img=new Image(),url=URL.createObjectURL(data);img.onload=()=>{URL.revokeObjectURL(url);resolve(img)};img.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Unable to display frame'))};img.src=url});
}
function LiveCanvas({source,enabled=true}:{source:Data,enabled?:boolean}){
  const canvas=useRef<HTMLCanvasElement>(null);
  const [status,setStatus]=useState('Connecting preview…'),[metrics,setMetrics]=useState<Data>({fps:0});
  useEffect(()=>{
    if(!enabled)return;
    let stopped=false,ws:WebSocket,retry=0,meta:Data|null=null,stage=0,chain=Promise.resolve();
    let count=0,since=performance.now(),lastUi=0;setMetrics({fps:0});
    function connect(){
      if(stopped)return;ws=new WebSocket(socketUrl(`/ws/preview?source_id=${encodeURIComponent(source.id)}`));ws.binaryType='blob';
      ws.onopen=()=>setStatus('Live · newest frame');
      ws.onmessage=event=>{chain=chain.then(async()=>{
        if(stopped)return;
        if(typeof event.data==='string'){const m=JSON.parse(event.data);if(m.type==='status'){setStatus(m.status==='completed'?'Stream ended':'Waiting for camera…');return}meta=m;stage=0;return}
        if(!meta)return;const frame=meta;
        if(stage===0){const image=await decode(event.data);if(!stopped&&canvas.current){
          const target=canvas.current;if(target.width!==image.width||target.height!==image.height){target.width=image.width;target.height=image.height}
          target.getContext('2d')!.drawImage(image,0,0);
        }if('close' in image)image.close();count++;stage=1;}
        else stage=2; // Consume optional experimental MOSS localization frame without mislabeling it.
        if(!frame.objects_frame_included||stage===2){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'displayed',index:frame.index}));meta=null}
        const now=performance.now();if(now-lastUi>400){setMetrics({fps:count*1000/Math.max(1,now-since),rtt:frame.previous_roundtrip_ms});lastUi=now;if(now-since>2000){count=0;since=now}}
      }).catch(()=>{if(!stopped){setStatus('Reconnecting preview…');ws.close()}})};
      ws.onclose=()=>{if(!stopped){setStatus('Reconnecting preview…');retry=window.setTimeout(connect,700)}};ws.onerror=()=>setStatus('Preview connection interrupted');
    }
    connect();return()=>{stopped=true;clearTimeout(retry);ws?.close()};
  },[source.id,enabled]);
  const alert=source.telemetry?.review_alert,flagged=alert&&source.telemetry.timestamp-(alert.received_stream_time??alert.timestamp)<35;
  return <div className={'live-video-wrap '+(flagged?'flagged':'')}><div className="preview-heading"><span><i className={'dot '+(flagged?'red':'green')}/>{flagged?'Possible incident · review required':status}</span><span>{metrics.fps.toFixed(1)} display FPS {metrics.rtt!=null&&`· ${Math.round(metrics.rtt)} ms display round trip`}</span></div><div className="canvas-stage"><canvas ref={canvas} aria-label="Live original video"/><span className="source-caption">ORIGINAL LIVE FEED · {source.name}</span></div></div>
}
function LiveVideo({source}:{source:Data}){
  const video=useRef<HTMLVideoElement>(null);
  const [ready,setReady]=useState(false),[status,setStatus]=useState('Connecting direct video…');
  const [metrics,setMetrics]=useState<LiveMetrics|null>(null),[displayFps,setDisplayFps]=useState<number|null>(null),[renderDropped,setRenderDropped]=useState(0);
  useEffect(()=>{
    setReady(false);setMetrics(null);setDisplayFps(null);setRenderDropped(0);
    if(!['phone','webcam'].includes(source.kind))return;
    let stopped=false,lastDecoded=performance.now(),lastMeasurement=lastDecoded,presentedAtMeasurement:number|null=null,callback=0;
    const element=video.current!,hasFrameCallback=typeof element.requestVideoFrameCallback==='function';
    // Count frames actually submitted for presentation, independently of network FPS.
    function painted(now:number,metadata:VideoFrameCallbackMetadata){if(stopped)return;
      // A busy main thread can miss callbacks while the compositor keeps presenting.
      // Browser counters measure presented frames rather than callback throughput.
      if(presentedAtMeasurement===null){presentedAtMeasurement=metadata.presentedFrames;lastMeasurement=now}
      if(now-lastMeasurement>=1000){setDisplayFps((metadata.presentedFrames-presentedAtMeasurement)*1000/(now-lastMeasurement));setRenderDropped(element.getVideoPlaybackQuality?.().droppedVideoFrames||0);presentedAtMeasurement=metadata.presentedFrames;lastMeasurement=now}
      callback=element.requestVideoFrameCallback(painted);
    }
    if(hasFrameCallback)callback=element.requestVideoFrameCallback(painted);
    const disconnect=receiveLiveVideo(source.id,setStatus,stream=>{
      if(stopped)return;if(!stream){setReady(false);return}
      element.srcObject=stream;element.play().catch(()=>setStatus('Tap the camera video to start playback'));
    },m=>{if(stopped)return;setMetrics(m);if(hasDecodedVideo(m,element)){lastDecoded=performance.now();setReady(true)}});
    const watchdog=window.setInterval(()=>{if(performance.now()-lastDecoded>3500)setReady(false)},1000);
    return()=>{stopped=true;disconnect();clearInterval(watchdog);if(callback)element.cancelVideoFrameCallback(callback);element.srcObject=null};
  },[source.id,source.kind]);
  const alert=source.telemetry?.review_alert,flagged=alert&&source.telemetry.timestamp-(alert.received_stream_time??alert.timestamp)<35;
  return <div className="direct-video-container">
    <div style={{position:'relative'}}><div style={{visibility:ready?'hidden':'visible'}}><LiveCanvas source={source} enabled={!ready}/></div><div className={'live-video-wrap '+(flagged?'flagged':'')} style={{position:'absolute',inset:0,opacity:ready?1:0,pointerEvents:ready?'auto':'none'}}>
      <div className="preview-heading"><span><i className={'dot '+(flagged?'red':'green')}/>{flagged?'Possible incident · review required':status}</span><span>{displayFps!==null?`${displayFps.toFixed(1)} display FPS`:metrics?`${metrics.fps.toFixed(1)} decoded FPS`:'Measuring video…'} · {metrics?.width} × {metrics?.height}</span></div>
      <div className="canvas-stage"><video ref={video} autoPlay muted playsInline onClick={()=>video.current?.play()} aria-label="Live camera video" style={{display:'block',width:'100%',height:'100%',maxHeight:620,objectFit:'contain',background:'#0b151a'}}/><span className="source-caption">LIVE CAMERA VIDEO · {source.name}</span></div>
    </div></div>
    <p className="fine" role="status">{ready?`60 FPS target · ${metrics?.route==='relay'?'Private relay':metrics?.route==='direct'?'Direct connection':'Checking connection'}${metrics?.transport?` / ${metrics.transport.toUpperCase()}`:''} · ${metrics?.fps.toFixed(1)||'—'} decoded FPS · ${metrics?.mbps.toFixed(1)||'—'} Mbps · ${metrics?.dropped||0} decode drops · ${renderDropped} presentation drops · ${metrics?.bufferMs.toFixed(0)||'—'} ms jitter buffer · ${metrics?.rttMs.toFixed(0)||'—'} ms network round trip`:`${status} · Context preview has a separate, lower frame rate.`}</p>
  </div>
}
const captureLive=(source?:Data)=>source?.status==='streaming'&&source.telemetry?.capture_active!==false&&!source.telemetry?.stream_ended;
const finishingAnalysis=(source?:Data)=>!!source&&(source.status==='processing'||source.telemetry?.stream_ended===true&&['streaming','warming','waiting_for_gpu'].includes(source.status));
function ModelActivity({source}:{source?:Data}){
  const phase=source?.telemetry?.model_status||source?.status||'not_started';
  const finishing=finishingAnalysis(source),live=captureLive(source);
  const active=!!source&&(['streaming','warming','waiting_for_gpu','processing'].includes(source.status));
  const progress=source?.telemetry?.verification_progress;
  const startedAt=typeof progress?.started_at==='number'&&Number.isFinite(progress.started_at)?progress.started_at:null;
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{if(!active||startedAt===null)return;setNow(Date.now());const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer)},[active,startedAt]);
  const elapsed=active&&startedAt!==null?Math.max(0,Math.floor(now/1000-startedAt)):null;
  const labels:Record<string,string>={loading:'Loading models',loading_verifier:'Loading visual verifier',warming:'Loading models',verifying:progress?.pass==='event_context_confirmation'?'Visual verifier · checking event context':`Visual verifier · checking ${finishing?'remaining':'live'} frames`,confirming_event:'Visual verifier · checking event context',observing:finishing?'Finishing remaining analysis':'Waiting for next MOSS result',waiting_for_gpu:'Waiting for analysis',not_started:'Starting analysis'};
  const label=phase==='error'?'Analysis unavailable':!active?(source?.status==='completed'?'Analysis finished':'Analysis paused'):labels[phase]||(finishing?'Finishing remaining analysis':'Waiting for next MOSS result');
  const working=active&&['loading','loading_verifier','warming','verifying','confirming_event'].includes(phase);
  const waiting=active&&!working&&phase!=='error';
  return <div className={'model-activity '+(working?'working':waiting?'waiting':'idle')} role="status" aria-live="polite">
    <span className="model-activity-ring" aria-hidden="true">{working?<LoaderCircle size={18}/>:<span/>}</span><div><strong>{label}</strong><small>{working?`${elapsed===null?'':`${elapsed}s elapsed · `}${live?'Video continues while analysis runs.':finishing?'Stream ended; checking received footage.':'Preparing analysis.'}`:waiting?(finishing?'Stream ended. Saving context and final results.':'Scene notes appear when MOSS responds; verification is a separate pass.'):'Observations already received remain below.'}</small></div>
  </div>;
}
function ObservationFeed({source,onOpen}:{source?:Data,onOpen:(id:string)=>void}){
  const list=useRef<HTMLDivElement>(null),stick=useRef(true);
  const notes:Data[]=source?.telemetry?.moss_chat||[],alert=source?.telemetry?.review_alert;
  const alerts:Data[]=source?.telemetry?.review_alerts?.length?source.telemetry.review_alerts:alert?[alert]:[];
  const gate=source?.telemetry?.alert_gate,observation=source?.telemetry?.last_observation;
  const eventName=(action:string)=>action==='physical_contact'?'Physical contact flagged':action==='object_taking'?'Object-taking action flagged':'Possible incident';
  const live=captureLive(source),finishing=finishingAnalysis(source);
  useEffect(()=>{if(stick.current&&list.current)list.current.scrollTop=list.current.scrollHeight},[notes.length,alert?.id,alert?.status,source?.telemetry?.alert_gate?.reason]);
  return <section className="observation-feed"><div className="chat-heading"><div><MessageSquare size={18}/><strong>MOSS live observations</strong></div><span className={'pill '+(live?'teal':'')}>{live?'Receiving video':finishing?'Finishing':source&&['completed','failed','disconnected','expired'].includes(source.status)?'Stream ended':'Not started'}</span></div><ModelActivity source={source}/><p className="chat-intro">Automatic scene observations while video is running. Received timestamps show when a response arrived, not an exact action time.</p>
    <div ref={list} className="chat-messages" role="log" aria-live="polite" onScroll={e=>{const el=e.currentTarget;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<70}}>
      {!notes.length&&<div className="chat-empty"><Eye size={28}/><h3>{live?'Waiting for MOSS scene notes.':finishing?'Processing remaining frames.':source&&['completed','failed','disconnected','expired'].includes(source.status)?'This stream has ended.':'Start a video to begin.'}</h3><p>{live?'Observations appear after MOSS responds. Silence is not a guarantee that nothing happened.':finishing?'The camera has stopped. Any remaining observations will appear when analysis finishes.':source&&['completed','failed','disconnected','expired'].includes(source.status)?'No scene notes were received for this source.':'Connect a phone or upload a clip. Model observations will appear here automatically.'}</p></div>}
      {notes.map(note=><article className="chat-bubble" key={note.id}><div><span className="model-avatar">M</span><strong>MOSS</strong><time>Received · {clock(note.received_stream_time)}</time></div><p>{note.text}</p></article>)}
      {gate?.reason==='awaiting_confirmation'&&<article className="chat-bubble"><strong>Checking a possible event</strong><p>{observation?.observable_events?.[0]?.observation}</p><small>A second original-frame set is being checked before creating an incident.</small></article>}{alerts.map(alert=><article className="chat-bubble alert-bubble" key={alert.id}><div><AlertTriangle size={17}/><strong>{eventName(alert.action)}</strong><time>{clock(alert.timestamp)}</time></div><p>{alert.message}</p><small>Model score {Math.round((alert.confidence??0)*100)} / threshold {Math.round((alert.threshold??0)*100)} · two original-frame sets. Scores are uncalibrated; human review is required.</small><div className="recording-state">{alert.status==='saved'?'Clip saved automatically':alert.status==='failed'?'Recording failed — check source storage':'Saving surrounding video…'}</div>{alert.status==='saving_context'&&<p className="fine">Preserving the buffered lead-up and the configured post-event context.</p>}{alert.incident_id&&<button className="primary" onClick={()=>onOpen(alert.incident_id)}>Open incident review</button>}{alert.error&&<p className="error">{alert.error}</p>}</article>)}
    </div><div className="chat-footer"><i className={'dot '+(live?'green':'')}/>{live?'Receiving video · MOSS scene notes and visual verification run separately.':finishing?'Camera stopped · finishing analysis of received footage.':source&&['completed','failed','disconnected','expired'].includes(source.status)?'Stream ended · observations remain attached to this source.':'Waiting for a video source.'}</div></section>
}
export default function LiveMonitor({source,onPair,onUpload,onOpen}:{source?:Data,onPair:()=>void,onUpload:(file:File)=>void,onOpen:(id:string)=>void}){
  const live=captureLive(source),finishing=finishingAnalysis(source);
  return <section className="monitor lv-panel"><div className="panel-title"><Radio size={18}/><h3>Live monitor</h3><span className={'pill '+(live?'teal':'')}>{finishing?'Stream ended · processing':source?.status||'No source connected'}</span></div><div className="live-chat-layout">
    {live?<LiveVideo source={source!}/>:<div className="empty-camera live-empty"><div className="camera-ring"><Camera size={34}/></div><h3>{finishing?'Stream ended.':'A view starts here.'}</h3><p>{finishing?'Processing the remaining frames and saving incident context.':'Connect a phone or upload a video to start the live view and MOSS observation feed.'}</p>{!finishing&&<div><button className="primary" onClick={onPair}><Smartphone size={16}/>Pair phone camera</button><label className="button"><Upload size={16}/>Upload video<input hidden type="file" accept="video/mp4,video/quicktime,video/webm" onChange={e=>e.target.files?.[0]&&onUpload(e.target.files[0])}/></label></div>}</div>}
    <ObservationFeed source={source} onOpen={onOpen}/></div>
    <div className="live-telemetry">{[[Sun,'Lighting',source?.telemetry?.lighting?.state?.replaceAll('_',' ')||'Waiting'],[Clock,'Preserved context',`${(source?.telemetry?.buffer_seconds||0).toFixed(1)}s buffered`],[Activity,'Event verification',source?.telemetry?.safety_state==='NORMAL'?'No event flagged':source?.telemetry?.safety_state?.replaceAll('_',' ')||'Awaiting video'],[Eye,'Analysis status',source?.telemetry?.model_status||'Not started']].map(([Icon,label,value]:any)=><div key={label}><Icon size={15}/><span>{label}</span><strong>{value}</strong></div>)}</div>
    {source&&['phone','webcam'].includes(source.kind)&&<CameraLocation location={source.telemetry?.geolocation} live={!!live} title={live?'Camera location':'Last camera location'}/>}
    {source?.telemetry?.error&&<p className="error">{source.telemetry.error}</p>}
  </section>
}
