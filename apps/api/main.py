import asyncio
import hmac
import json
import math
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect, Depends
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from .config import settings
from .db import init, Source, Incident, Job, ReviewAction, ArchiveState, rows, get, save
from .schemas import SourceRequest, Review, RetentionHoldRequest
from .video import Frame, digest, decode
from .runtime import hub, sessions, pairings, VideoSession, replay
from .jobs import worker, retention

tasks=set()
upload_in_progress=False
def busy():
    from . import jobs
    return bool(sessions) or jobs.gpu_busy or upload_in_progress
def background(coro):
    task=asyncio.create_task(coro); tasks.add(task); task.add_done_callback(tasks.discard); return task

@asynccontextmanager
async def lifespan(app):
    from .archive import archive_worker
    from .recording import reset_spool, retention as recording_retention
    await asyncio.to_thread(reset_spool)
    init()
    from .training_control import recover_training_runs
    recover_training_runs()
    background(worker()); background(retention()); background(archive_worker()); background(recording_retention())
    yield
    for task in list(tasks): task.cancel()
    await asyncio.gather(*tasks,return_exceptions=True)
    from .training_control import shutdown as stop_training_control
    await stop_training_control()
    for session in list(sessions.values()): await session.close()
    from .recording import cleanup_all
    await cleanup_all()
    from ml.service import model_service
    from ml.verifier import release_verifier
    await model_service.stop()
    await asyncio.to_thread(release_verifier)

app=FastAPI(title='Palladium',lifespan=lifespan)
def authenticated(request: Request):
    token=request.cookies.get('safesc_token') or request.headers.get('Authorization','').removeprefix('Bearer ')
    if not token or not hmac.compare_digest(token,settings.app_token): raise HTTPException(401,'Sign in to Palladium')

from .live import router as live_router
app.include_router(live_router)
from .recording import router as recording_router
app.include_router(recording_router)

from .activity import router as activity_router
app.include_router(activity_router, dependencies=[Depends(authenticated)])
from .learning import router as learning_router
app.include_router(learning_router, dependencies=[Depends(authenticated)])
from starlette.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1000)

@app.post('/api/login')
async def login(request:Request,response:Response):
    payload=await request.json()
    if not hmac.compare_digest(str(payload.get('token','')),settings.app_token): raise HTTPException(401,'Invalid access token')
    response.set_cookie('safesc_token',settings.app_token,httponly=True,secure=request.url.scheme=='https',samesite='strict',max_age=86400)
    return {'ok':True}

@app.get('/api/health',dependencies=[Depends(authenticated)])
async def health():
    gpu=[]
    try:
        proc=await asyncio.create_subprocess_exec('nvidia-smi','--query-gpu=name,memory.used,memory.total,utilization.gpu','--format=csv,noheader,nounits',stdout=asyncio.subprocess.PIPE)
        out,_=await asyncio.wait_for(proc.communicate(),3); gpu=out.decode().strip().splitlines()
    except (OSError,asyncio.TimeoutError): pass
    from ml.service import model_service
    from ml.verifier import verifier_is_loaded,verifier_metadata
    return {'status':'ok','streaming_model':settings.streaming_model,'revision':settings.model_revision,
        'simulated':settings.streaming_model=='fixture','gpu':gpu,'active_sources':len(sessions),
        'enhancement_model':settings.enhancement_model,'postprocessing_waits_for_idle':True,
        'moss_process_running':bool(model_service.process and model_service.process.returncode is None),
        'visual_verifier':settings.observation_verifier_model,'visual_verifier_loaded':verifier_is_loaded(),
        'verifier_research_mode':settings.verifier_research_mode,'verifier_artifact':verifier_metadata(),
        'tracking_enabled':settings.enable_tracking,'relayvsr_enabled':settings.enable_relay_vsr,
        'clip_review_enabled':settings.enable_clip_review,'preview_transport':'webrtc-camera-with-jpeg-fallback',
        'alert_threshold':settings.alert_confidence_threshold,'verification_frame_count':settings.verification_frame_count,
        'max_inference_lag_seconds':settings.max_inference_lag_seconds,
        'incident_windows':{'pre_seconds':settings.pre_event_seconds,'post_seconds':settings.post_event_seconds,'object_post_seconds':settings.object_post_event_seconds},
        'relift_enabled':settings.enable_relift,'bvimamba_enabled':settings.enable_bvimamba,
        'retention_hours':settings.retention_hours}

@app.post('/api/models/moss/warm',dependencies=[Depends(authenticated)])
async def warm_moss():
    if busy(): raise HTTPException(409,'Stop the current stream or wait for postprocessing')
    from ml.service import model_service
    try:
        await model_service.ensure()
        if settings.observation_verifier_model=='qwen3vl':
            from ml.verifier import acquire_verifier
            await asyncio.to_thread(acquire_verifier,settings.verifier_checkpoint)
        import httpx
        url=settings.moss_ws_url.replace('ws://','http://').replace('wss://','https://').split('/v1/')[0]+'/health'
        async with httpx.AsyncClient(timeout=3) as client:
            response=await client.get(url)
            response.raise_for_status()
            if not response.json().get('model_loaded'):raise RuntimeError('MOSS is not loaded')
    except Exception as e:
        raise HTTPException(503,str(e))
    return {'status':'ready','model':'moss','revision':settings.model_revision}

@app.get('/api/sources',dependencies=[Depends(authenticated)])
def sources(): return sorted(rows(Source),key=lambda source:source.created_at,reverse=True)

@app.post('/api/sources/{source_id}/bookmark',dependencies=[Depends(authenticated)])
async def bookmark(source_id:str):
    session=sessions.get(source_id)
    if not session:raise HTTPException(409,'Connect a source before marking a moment')
    try:return session.bookmark()
    except ValueError as error:raise HTTPException(409,str(error))

@app.get('/api/reviews/export',dependencies=[Depends(authenticated)])
def export_reviews():
    incidents={i.id:i for i in rows(Incident)}
    return {'kind':'human-review-feedback','automatic_training':False,
        'note':'Reviewer judgments are not independent ground truth. Evaluate proposed changes on a held-out labeled set.',
        'reviews':[{**r.model_dump(),'model_provenance':incidents[r.incident_id].record.get('model',{}),
            'observation_model':incidents[r.incident_id].record.get('observation_model',{}),
            'source_sha256':incidents[r.incident_id].record.get('source_sha256'),
            'trigger_origin':incidents[r.incident_id].record.get('trigger_origin','model'),
            'simulated':incidents[r.incident_id].simulated} for r in rows(ReviewAction) if r.incident_id in incidents]}

@app.post('/api/sources',dependencies=[Depends(authenticated)])
async def source_create(payload:SourceRequest):
    if payload.kind=='rtsp' and not settings.allow_rtsp: raise HTTPException(400,'RTSP must be explicitly enabled by the operator')
    if payload.kind=='rtsp' and (not payload.url or not payload.url.startswith(('rtsp://','rtsps://'))): raise HTTPException(400,'Expected RTSP URL')
    from .training_control import cancel_active_training
    try:await cancel_active_training('Camera connection requested; returning GPU to live analysis')
    except TimeoutError as error:raise HTTPException(409,str(error))
    if sessions or upload_in_progress: raise HTTPException(409,'Stop the active source before connecting another')
    source=save(Source(name=payload.name,kind=payload.kind,telemetry={'review_copies':payload.review_copies}))
    if payload.kind=='rtsp': background(replay(source,payload.url))
    token=secrets.token_urlsafe(32); pairings[token]={'source_id':source.id,'expires':time.time()+3600}
    return {'source':source,'capture_url':f'{settings.public_url}/capture#{token}'}

@app.post('/api/upload',dependencies=[Depends(authenticated)])
async def upload(file:UploadFile):
    global upload_in_progress
    if sessions or upload_in_progress: raise HTTPException(409,'Stop the active source before uploading another')
    if Path(file.filename or '').suffix.lower() not in ['.mp4','.mov','.webm']: raise HTTPException(400,'Use MP4, MOV or WebM')
    from .training_control import cancel_active_training
    try:await cancel_active_training('Video analysis requested; returning GPU to live analysis')
    except TimeoutError as error:raise HTTPException(409,str(error))
    source=Source(name=Path(file.filename).name,kind='upload')
    folder=settings.data_dir/'uploads'; folder.mkdir(exist_ok=True)
    path=folder/f'{source.id}{Path(file.filename).suffix.lower()}'
    total=0; upload_in_progress=True
    try:
        with path.open('xb') as out:
            while chunk:=await file.read(1024*1024):
                total+=len(chunk)
                if total>settings.max_upload_mb*1024**2: raise HTTPException(413,'Video exceeds upload size limit')
                out.write(chunk)
        if not total: raise HTTPException(400,'Empty upload')
        path.chmod(0o444); source.path=str(path); source.original_sha256=await asyncio.to_thread(digest,path)
        save(source); background(replay(source,path)); return source
    except BaseException:
        path.unlink(missing_ok=True); raise
    finally:
        upload_in_progress=False
        await file.close()

@app.get('/api/incidents',dependencies=[Depends(authenticated)])
def incidents():
    from .presentation import processing_summary
    jobs={}
    for job in rows(Job):jobs.setdefault(job.incident_id,[]).append(job)
    return [{**i.model_dump(),'processing_summary':processing_summary(i,jobs.get(i.id,[]))}
        for i in sorted(rows(Incident),key=lambda i:i.created_at,reverse=True)]

@app.get('/api/incidents/{incident_id}',dependencies=[Depends(authenticated)])
def incident_detail(incident_id:str):
    incident=get(Incident,incident_id)
    if not incident: raise HTTPException(404)
    source=get(Source,incident.source_id)
    return {'incident':incident,'source':{'name':source.name,'kind':source.kind} if source else None,
        'archive':get(ArchiveState,incident_id),
        'jobs':[j for j in rows(Job) if j.incident_id==incident_id],
        'history':[r for r in rows(ReviewAction) if r.incident_id==incident_id]}

@app.post('/api/incidents/{incident_id}/review',dependencies=[Depends(authenticated)])
async def review(incident_id:str,payload:Review):
    incident=get(Incident,incident_id)
    if not incident: raise HTTPException(404)
    save(ReviewAction(incident_id=incident_id,decision=payload.decision,note=payload.note))
    incident.review_status=payload.decision; save(incident)
    if payload.decision=='confirmed':
        from .learning import retain_incident
        try:retain_incident(incident)
        except (ValueError,OSError) as error:
            # Event review is independent of training eligibility or expired media.
            await hub.publish('learning_warning',{'incident_id':incident.id,'message':str(error)})
    await hub.publish('incident',incident.model_dump()); return incident

@app.post('/api/incidents/{incident_id}/retention-hold',dependencies=[Depends(authenticated)])
async def retention_hold(incident_id:str,payload:RetentionHoldRequest):
    from .retention import set_hold
    try:incident=await asyncio.to_thread(set_hold,incident_id,payload.active,payload.note)
    except LookupError:raise HTTPException(404,'Incident not found')
    except ValueError as error:raise HTTPException(409,str(error))
    await hub.publish('incident',incident.model_dump())
    return incident

@app.get('/api/storage',dependencies=[Depends(authenticated)])
def storage_status():
    from . import archive
    return {'enabled':archive.enabled(),'provider':'Supabase','bucket':settings.supabase_bucket,
        'visibility':'private','cap_mb':settings.archive_max_mb,'used_bytes':archive.usage_bytes,
        'eviction':'FIFO of unheld archived media; explicit retention holds remain until released. New backups can fail at the cap.',
        'retention_hours':settings.retention_hours,'last_error':archive.last_error,
        'incidents':[s.model_dump(exclude={'media','fingerprint'}) for s in rows(ArchiveState)]}

@app.post('/api/jobs/{job_id}/retry',dependencies=[Depends(authenticated)])
def retry(job_id:str):
    job=get(Job,job_id)
    if not job: raise HTTPException(404)
    if job.status!='failed': raise HTTPException(409,'Only failed jobs may be retried')
    job.status='queued'; job.error=None; return save(job)

@app.post('/api/incidents/{incident_id}/compare',dependencies=[Depends(authenticated)])
def compare(incident_id:str):
    if not settings.enable_bvimamba:raise HTTPException(400,'The offline comparison model is not enabled')
    incident=get(Incident,incident_id)
    if not incident:raise HTTPException(404)
    if incident.record.get('expired'):raise HTTPException(410,'Source media has expired')
    existing=[j for j in rows(Job) if j.incident_id==incident_id and j.kind=='bvimamba' and j.status in ['queued','running']]
    return existing[0] if existing else save(Job(incident_id=incident_id,kind='bvimamba',priority=4))

@app.post('/api/incidents/{incident_id}/refresh-motion',dependencies=[Depends(authenticated)])
def refresh_motion(incident_id:str):
    incident=get(Incident,incident_id)
    if not incident:raise HTTPException(404)
    if incident.record.get('expired'):raise HTTPException(410,'Source media has expired')
    existing=[j for j in rows(Job) if j.incident_id==incident_id and j.kind=='relift_export' and j.status in ['queued','running']]
    return existing[0] if existing else save(Job(incident_id=incident_id,kind='relift_export',priority=1))

@app.post('/api/incidents/{incident_id}/clip-review',dependencies=[Depends(authenticated)])
def request_clip_review(incident_id:str):
    if not settings.enable_clip_review:raise HTTPException(400,'Secondary clip review is not enabled')
    incident=get(Incident,incident_id)
    if not incident:raise HTTPException(404)
    if incident.record.get('expired'):raise HTTPException(410,'Source media has expired')
    existing=[j for j in rows(Job) if j.incident_id==incident_id and j.kind=='review_brief' and j.status in ['queued','running']]
    return existing[0] if existing else save(Job(incident_id=incident_id,kind='review_brief',priority=0))

@app.get('/api/incidents/{incident_id}/media/{kind}',dependencies=[Depends(authenticated)])
def media(incident_id:str,kind:str):
    incident=get(Incident,incident_id)
    if not incident: raise HTTPException(404)
    filename=incident.record.get('files',{}).get(kind)
    if not filename: raise HTTPException(404,'Artifact not available')
    path=settings.data_dir/'incidents'/incident_id/filename
    if not path.is_file(): raise HTTPException(404)
    return FileResponse(path,headers={'Cache-Control':'private, no-store'})

@app.get('/api/sources/{source_id}/frame',dependencies=[Depends(authenticated)])
def latest_frame(source_id:str,enhanced:bool=False):
    session=sessions.get(source_id)
    data=(session.enhanced_latest if enhanced else session.latest) if session else None
    if not data: raise HTTPException(404)
    return Response(data,media_type='image/jpeg',headers={'Cache-Control':'no-store'})

@app.websocket('/ws/events')
async def events(ws:WebSocket):
    if not hmac.compare_digest(ws.cookies.get('safesc_token',''),settings.app_token): await ws.close(4401); return
    await ws.accept(); q=asyncio.Queue(maxsize=32); hub.listeners.add(q)
    try:
        while True:
            try: event=await asyncio.wait_for(q.get(),20)
            except asyncio.TimeoutError: event={'type':'ping','payload':{}}
            await ws.send_json(event)
    except (WebSocketDisconnect,RuntimeError): pass
    finally: hub.listeners.discard(q)

from . import dispatch_agent

@app.post('/api/dispatch/recommend',dependencies=[Depends(authenticated)])
async def dispatch_recommend(body:dispatch_agent.RecommendRequest):
    return await dispatch_agent.recommend(body)

from . import debate

@app.post('/api/debate',dependencies=[Depends(authenticated)])
async def debate_alert(body:debate.DebateEvidence):
    return await debate.run_debate(body)

@app.post('/api/dispatch/approve',dependencies=[Depends(authenticated)])
def dispatch_approve(body:dispatch_agent.ApproveRequest):
    try: return dispatch_agent.approve(body)
    except dispatch_agent.ApprovalError as e: raise HTTPException(e.status,e.detail)

# Dispatch relay between the command dashboard and officer phones. The room id is a random
# 128-bit capability the dashboard generates and shares through the officer pairing link;
# the relay only forwards small JSON messages between peers in the same room and keeps nothing.
dispatch_rooms:dict[str,set]={}
DISPATCH_ROOM=__import__('re').compile(r'[A-Za-z0-9_-]{22,64}')

@app.websocket('/ws/dispatch/{room}')
async def dispatch_relay(ws:WebSocket,room:str):
    if not DISPATCH_ROOM.fullmatch(room): await ws.close(4400); return
    peers=dispatch_rooms.setdefault(room,set())
    if len(peers)>=32: await ws.close(4429); return
    await ws.accept(); peers.add(ws)
    try:
        while True:
            text=await ws.receive_text()
            if len(text)>16384: continue
            try: json.loads(text)
            except ValueError: continue
            for peer in list(peers):
                if peer is ws: continue
                try: await peer.send_text(text)
                except Exception: peers.discard(peer)
    except (WebSocketDisconnect,RuntimeError): pass
    finally:
        peers.discard(ws)
        if not peers: dispatch_rooms.pop(room,None)

@app.websocket('/ws/capture')
async def capture(ws:WebSocket):
    await ws.accept(); session=None
    try:
        hello=await asyncio.wait_for(ws.receive_json(),10)
        pairing=pairings.get(hello.get('token',''))
        if not pairing or pairing['expires']<time.time(): await ws.close(4401,'Pairing expired'); return
        if sessions or upload_in_progress: await ws.close(4409,'Another stream is active'); return
        from .training_control import cancel_active_training
        await cancel_active_training('Phone started streaming; returning GPU to live analysis')
        source=get(Source,pairing['source_id']); session=VideoSession(source); session.native_recording_expected=settings.enable_native_recording and hello.get('native_recording') is True; sessions[source.id]=session
        await ws.send_json({'type':'ready','fps':settings.capture_fps,'source_id':source.id,'native_recording':settings.enable_native_recording,'geolocation':True})
        index=0; first=None
        while True:
            meta=await asyncio.wait_for(ws.receive_json(),30)
            if meta.get('type')=='geolocation':
                await ws.send_json(await session.update_geolocation(meta))
                continue
            if meta.get('type')=='stop':
                await session.close(); session=None
                await ws.send_json({'type':'stopped'})
                break
            raw=await asyncio.wait_for(ws.receive_bytes(),10)
            if len(raw)>2*1024*1024: raise ValueError('Frame exceeds 2 MB')
            stamp=float(meta['timestamp'])
            if first is None:
                first=stamp; session.capture_epoch=first
            stamp-=first
            if not math.isfinite(stamp) or stamp<0 or stamp>86400: raise ValueError('Invalid timestamp')
            await session.push(Frame(stamp,index,raw)); index+=1
            await ws.send_json({'type':'ack','index':index,'timestamp':stamp,'model_status':session.source.telemetry.get('model_status')})
    except WebSocketDisconnect: pass
    except Exception as e:
        try: await ws.send_json({'type':'error','message':str(e)[:500]})
        except RuntimeError: pass

    finally:
        if session: await session.close()
        try: await ws.close()
        except RuntimeError: pass

@app.websocket('/ws/preview')
async def preview(ws:WebSocket):
    """One in-flight display frame per viewer; slow clients always skip to newest."""
    if not hmac.compare_digest(ws.cookies.get('safesc_token',''),settings.app_token):
        await ws.close(4401);return
    source_id=ws.query_params.get('source_id','')
    if not get(Source,source_id):await ws.close(4404);return
    await ws.accept();last_index=-1;last_objects=-1;rtt=None
    try:
        while True:
            session=sessions.get(source_id)
            if not session or session.closing:
                await ws.send_json({'type':'status','status':'waiting' if not session else 'completed'})
                await asyncio.sleep(.25)
                if not session and get(Source,source_id).status in ['completed','failed','disconnected']:break
                continue
            frame=session.latest_frame
            if frame is None or frame.index==last_index:await asyncio.sleep(.01);continue
            sample=getattr(session.detector,'object_sample',None)
            version=getattr(session.detector,'object_version',0)
            include=bool(sample and version!=last_objects)
            started=time.monotonic()
            await ws.send_json({'type':'frame','index':frame.index,'timestamp':frame.timestamp,
                'previous_roundtrip_ms':rtt,'intake_fps':session.count/max(.01,time.monotonic()-session.started),
                'objects_frame_included':include,'moss_context':getattr(session.detector,'observer_text','')[-350:],
                'objects_sample':{k:v for k,v in sample.items() if k!='jpeg'} if sample else None})
            await ws.send_bytes(frame.jpeg)
            if include:await ws.send_bytes(sample['jpeg']);last_objects=version
            ack=await asyncio.wait_for(ws.receive_json(),10)
            if ack.get('type')!='displayed' or ack.get('index')!=frame.index:await ws.close(4400);return
            rtt=round((time.monotonic()-started)*1000,1);last_index=frame.index
    except (WebSocketDisconnect,asyncio.TimeoutError,RuntimeError):pass
    finally:
        try:await ws.close()
        except RuntimeError:pass

web=Path('apps/web/dist')
if web.exists():
    app.mount('/assets',StaticFiles(directory=web/'assets'),name='assets')
    @app.get('/{path:path}')
    def frontend(path:str): return FileResponse(web/'index.html')
