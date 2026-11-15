"""Exercise the real phone protocol through an authenticated Palladium origin.

Uses a clearly documented public test image, not the device camera. No fixture
detector is enabled. A physical phone still requires a separate user smoke test.
"""
import asyncio
import io
import json
import os
import time
from pathlib import Path
import httpx
import websockets
from PIL import Image,ImageEnhance

async def main():
    origin=os.getenv('SAFESC_TEST_ORIGIN','http://127.0.0.1:8010')
    token=Path('data/runpod_app_token').read_text().strip()
    root=Path('data/phone-smoke');root.mkdir(parents=True,exist_ok=True)
    image=httpx.get('https://raw.githubusercontent.com/ultralytics/ultralytics/main/ultralytics/assets/bus.jpg',timeout=30)
    image.raise_for_status();picture=Image.open(io.BytesIO(image.content)).convert('RGB');picture.thumbnail((640,640))
    frames=[]
    for alpha in [1,.15]:
        data=io.BytesIO();ImageEnhance.Brightness(picture).enhance(alpha).save(data,format='JPEG');frames.append(data.getvalue())
    async with httpx.AsyncClient(base_url=origin,headers={'Authorization':f'Bearer {token}'},timeout=20) as client:
        response=await client.post('/api/sources',json={'name':'Public-image phone-protocol smoke test','kind':'phone'})
        response.raise_for_status();pair=response.json();source_id=pair['source']['id']
        pairing=pair['capture_url'].split('#')[1];acks=[];started=time.monotonic()
        async with websockets.connect(origin.replace('http://','ws://').replace('https://','wss://')+'/ws/capture',max_size=2**22) as ws:
            await ws.send(json.dumps({'token':pairing}));ready=json.loads(await ws.recv());assert ready['type']=='ready'
            for index in range(160):
                sent=time.monotonic();await ws.send(json.dumps({'type':'frame','timestamp':sent-started}))
                await ws.send(frames[0 if index<80 else 1])
                ack=json.loads(await asyncio.wait_for(ws.recv(),10));assert ack['type']=='ack',ack
                acks.append({'frame':index,'roundtrip_ms':(time.monotonic()-sent)*1000,'model_status':ack['model_status']})
                await asyncio.sleep(max(0,.125-(time.monotonic()-sent)))
            await ws.send(json.dumps({'type':'stop'}));stopped=json.loads(await asyncio.wait_for(ws.recv(),220));assert stopped['type']=='stopped',stopped
        response=await client.get('/api/sources');response.raise_for_status()
        source=next(s for s in response.json() if s['id']==source_id)
    result={'input':'Static public bus image then artificially darkened copy; real models; phone wire protocol',
        'physical_phone_tested':False,'source':source,'acks':acks,'runtime_seconds':time.monotonic()-started,
        'max_ack_ms':max(a['roundtrip_ms'] for a in acks),'mean_ack_ms':sum(a['roundtrip_ms'] for a in acks)/len(acks)}
    (root/'results.json').write_text(json.dumps(result,indent=2));print(json.dumps({k:v for k,v in result.items() if k!='acks'},indent=2))
    assert source['telemetry']['frame_count']==160
    assert source['telemetry']['inference_frames']>0
    assert not source['telemetry'].get('error'),source['telemetry'].get('error')

if __name__=='__main__':asyncio.run(main())
