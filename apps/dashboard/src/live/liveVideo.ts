// WebRTC carries the camera track; JPEG context capture remains independent.
type Message=Record<string,any>;
type Peer={pc:RTCPeerConnection,candidates:RTCIceCandidateInit[]};
export type LiveMetrics={fps:number,width:number,height:number,mbps:number,dropped:number,bufferMs:number,rttMs:number,route:'direct'|'relay'|'unknown',transport?:'udp'|'tcp'|'tls'};
export function hasDecodedVideo(metrics:Pick<LiveMetrics,'fps'|'width'|'height'>,video:Pick<HTMLVideoElement,'videoWidth'|'videoHeight'|'readyState'>){return metrics.fps>0&&metrics.width>0&&metrics.height>0&&video.videoWidth>0&&video.videoHeight>0&&video.readyState>=2}
const url=()=>`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/live`;

function signalVideo(hello:Message,stream:MediaStream|null,onStatus:(status:string)=>void,onTrack?:(stream:MediaStream|null)=>void,onMetrics?:(metrics:LiveMetrics)=>void){
  if(typeof RTCPeerConnection==='undefined'){onStatus('Direct video is unavailable in this browser · using context preview');return ()=>{}}
  let stopped=false,ws:WebSocket|null=null,retry=0,chain=Promise.resolve(),iceServers:RTCIceServer[]=[],iceTransportPolicy:RTCIceTransportPolicy='all',turnConfigured=false,diagnosticsSupported=false;
  const peers=new Map<string,Peer>(),previous=new Map<string,{timestamp:number,bytes:number,frames:number,delay:number,emitted:number}>();
  const send=(message:Message)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message))};
  function remove(id:string){peers.get(id)?.pc.close();peers.delete(id);previous.delete(id);if(!stream)onTrack?.(null)}
  function reset(){for(const id of peers.keys())remove(id)}
  function reconnect(){ws?.close()}
  function diagnostics(id:string,pc:RTCPeerConnection,extra:Message={}){if(!diagnosticsSupported)return;send({type:'diagnostics',remote_peer_id:id,connection_state:pc.connectionState,ice_connection_state:pc.iceConnectionState,ice_gathering_state:pc.iceGatheringState,signaling_state:pc.signalingState,...extra})}
  function phase(pc:RTCPeerConnection){onStatus(`Video connection ${pc.connectionState} · ICE ${pc.iceConnectionState} · ${turnConfigured?'relay available':'relay unavailable'}`)}
  function peer(id:string){
    const existing=peers.get(id);if(existing)return existing;
    const pc=new RTCPeerConnection({iceServers,iceTransportPolicy,bundlePolicy:'max-bundle'}),entry={pc,candidates:[] as RTCIceCandidateInit[]};peers.set(id,entry);
    pc.onicecandidate=e=>{if(e.candidate)send({type:'candidate',peer_id:id,candidate:e.candidate.toJSON()})};
    pc.ontrack=e=>{const receiver=e.receiver as RTCRtpReceiver&{jitterBufferTarget?:number,playoutDelayHint?:number};
      try{receiver.jitterBufferTarget=0;receiver.playoutDelayHint=0}catch{}onTrack?.(e.streams[0]||new MediaStream([e.track]));
      e.track.onended=()=>onTrack?.(null);
    };
    pc.oniceconnectionstatechange=()=>{diagnostics(id,pc);phase(pc)};
    pc.onicegatheringstatechange=()=>{diagnostics(id,pc);if(pc.connectionState!=='connected')phase(pc)};
    pc.onsignalingstatechange=()=>diagnostics(id,pc);
    pc.onconnectionstatechange=()=>{diagnostics(id,pc);phase(pc);if(pc.connectionState==='connected')onStatus(stream?'Direct video connected · target 1080p / 60 FPS':`Live camera video · ICE ${pc.iceConnectionState}`);
      if(pc.connectionState==='failed'){onStatus('Reconnecting direct video · using context preview');reconnect()}
      if(pc.connectionState==='disconnected'){onStatus('Direct video interrupted · using context preview');if(!stream)onTrack?.(null);window.setTimeout(()=>{if(!stopped&&pc.connectionState==='disconnected')reconnect()},4000)}
    };
    if(stream)for(const track of stream.getVideoTracks())pc.addTrack(track,stream);
    return entry;
  }
  async function description(entry:Peer,value:RTCSessionDescriptionInit){await entry.pc.setRemoteDescription(value);for(const c of entry.candidates)await entry.pc.addIceCandidate(c);entry.candidates=[]}
  async function message(m:Message){
    if(m.type==='ping'){send({type:'pong'});return}
    if(m.type==='ready'){iceServers=m.ice_servers;iceTransportPolicy=m.ice_transport_policy==='relay'?'relay':'all';turnConfigured=Boolean(m.turn_configured);diagnosticsSupported=m.diagnostics_supported===true;onStatus(stream?`Camera ready · target 1080p / 60 FPS${m.turn_configured?'':' · relay not configured'}`:`Waiting for camera offer · ${turnConfigured?'relay available':'relay unavailable'}`);return}
    if(m.type==='capture_ready'&&!stream){onStatus(`Camera connected · waiting for video offer · ${turnConfigured?'relay available':'relay unavailable'}`);return}
    if(m.type==='peer_left'){remove(m.peer_id);onStatus(stream?'Waiting for reviewer':'Waiting for phone · using context preview');return}
    if(m.type==='viewer_joined'&&stream){
      remove(m.peer_id);const entry=peer(m.peer_id);
      await entry.pc.setLocalDescription(await entry.pc.createOffer());
      for(const sender of entry.pc.getSenders())if(sender.track?.kind==='video'){
        const params=sender.getParameters();if(!params.encodings?.length)params.encodings=[{}];
        params.encodings[0].maxBitrate=16_000_000;params.encodings[0].maxFramerate=60;params.degradationPreference='maintain-resolution';
        try{await sender.setParameters(params)}catch{/* Older Safari retains its native encoder settings. */}
      }
      send({type:'offer',peer_id:m.peer_id,description:entry.pc.localDescription});return;
    }
    if(m.type==='offer'&&!stream){onStatus('Camera offer received · negotiating video');const entry=peer(m.peer_id);await description(entry,m.description);await entry.pc.setLocalDescription(await entry.pc.createAnswer());send({type:'answer',peer_id:m.peer_id,description:entry.pc.localDescription});return}
    if(m.type==='answer'&&stream){const entry=peers.get(m.peer_id);if(entry)await description(entry,m.description);return}
    if(m.type==='candidate'){const entry=peer(m.peer_id);if(entry.pc.remoteDescription)await entry.pc.addIceCandidate(m.candidate);else entry.candidates.push(m.candidate)}
    if(m.type==='error')onStatus(m.message||'Direct video unavailable · using context preview');
  }
  function connect(){
    if(stopped)return;chain=Promise.resolve();const socket=new WebSocket(url());ws=socket;
    socket.onopen=()=>socket.send(JSON.stringify(hello));
    socket.onmessage=e=>{chain=chain.then(()=>{if(!stopped&&ws===socket)return message(JSON.parse(e.data))}).catch(error=>{if(ws===socket){onStatus(`Video negotiation failed: ${error instanceof Error?error.message:'unknown error'}`);reconnect()}})};
    socket.onerror=()=>onStatus('Direct video connection interrupted · using context preview');
    socket.onclose=event=>{if(stopped||ws!==socket)return;reset();
      if([4400,4401,4404].includes(event?.code)){onStatus(event.reason||'Direct video authorization or configuration needs attention · using context preview');return}
      onStatus('Reconnecting direct video · using context preview');retry=window.setTimeout(connect,1500)};
  }
  let polling=false;
  const stats=window.setInterval(async()=>{
    if(polling||stopped)return;polling=true;
    try{for(const [id,{pc}] of peers){const report=await pc.getStats();diagnostics(id,pc);report.forEach((r:any)=>{
      if(r.type==='outbound-rtp'&&(r.kind||r.mediaType)==='video'){diagnostics(id,pc,{frames_encoded:r.framesEncoded,bytes_sent:r.bytesSent,fps:r.framesPerSecond,width:r.frameWidth,height:r.frameHeight});return}
      if(r.type!=='inbound-rtp'||(r.kind||r.mediaType)!=='video')return;
      const old=previous.get(id),elapsed=old?(r.timestamp-old.timestamp)/1000:0;
      const transport=report.get(r.transportId),pair=transport&&report.get(transport.selectedCandidatePairId);
      const local=pair&&report.get(pair.localCandidateId),remote=pair&&report.get(pair.remoteCandidateId);
      const route=pair?(local?.candidateType==='relay'||remote?.candidateType==='relay'?'relay':local&&remote?'direct':'unknown'):'unknown';
      const protocol=local?.relayProtocol||local?.protocol;
      const transportProtocol=['udp','tcp','tls'].includes(protocol)?protocol:undefined;
      const emitted=r.jitterBufferEmittedCount||0,delay=r.jitterBufferDelay||0;
      diagnostics(id,pc,{frames_decoded:r.framesDecoded,bytes_received:r.bytesReceived,fps:elapsed>0?(r.framesDecoded-old!.frames)/elapsed:0,width:r.frameWidth||0,height:r.frameHeight||0});
      onMetrics?.({fps:elapsed>0?(r.framesDecoded-old!.frames)/elapsed:0,width:r.frameWidth||0,height:r.frameHeight||0,
        mbps:elapsed>0?(r.bytesReceived-old!.bytes)*8/elapsed/1e6:0,dropped:r.framesDropped||0,
        bufferMs:old&&emitted>old.emitted?(delay-old.delay)/(emitted-old.emitted)*1000:0,rttMs:(pair?.currentRoundTripTime||0)*1000,route,transport:transportProtocol});
      previous.set(id,{timestamp:r.timestamp,bytes:r.bytesReceived,frames:r.framesDecoded,delay,emitted});
    })}}catch{/* Stats availability differs between browsers. */}finally{polling=false}
  },1000);
  connect();return()=>{stopped=true;clearTimeout(retry);clearInterval(stats);ws?.close();reset()};
}
export function publishLiveVideo(stream:MediaStream,token:string,onStatus:(status:string)=>void){return signalVideo({role:'capture',token},stream,onStatus)}
export function receiveLiveVideo(sourceId:string,onStatus:(status:string)=>void,onTrack:(stream:MediaStream|null)=>void,onMetrics:(metrics:LiveMetrics)=>void){return signalVideo({role:'viewer',source_id:sourceId},null,onStatus,onTrack,onMetrics)}
