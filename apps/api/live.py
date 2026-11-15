"""Authenticated WebRTC signaling only; camera media bypasses HTTP and the GPU.

The phone offers its browser-encoded stream to each reviewer. TURN servers may
be configured for networks that cannot establish a direct ICE connection.
"""
import asyncio
import anyio
import hmac
import base64
import hashlib
import json
import math
from collections import deque
import secrets
import time
from dataclasses import dataclass, field

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Request, HTTPException

from .config import settings
from .db import Source, get
from .runtime import pairings

router = APIRouter()


@dataclass(eq=False)
class Peer:
    id: str
    role: str
    socket: WebSocket
    connected_at: float = field(default_factory=time.time)
    diagnostics: dict = field(default_factory=dict)
    signals: dict = field(default_factory=dict)
    closing: bool = False
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=64))


rooms: dict[str, dict[str, Peer]] = {}
# Volatile, bounded summaries survive brief signaling reconnects for diagnosis.
recent_peers = deque(maxlen=128)
STATE_FIELDS = {
    'connection_state': {'new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'},
    'ice_connection_state': {'new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed'},
    'ice_gathering_state': {'new', 'gathering', 'complete'},
    'signaling_state': {'stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed'},
}
NUMBER_FIELDS = {'frames_decoded', 'frames_encoded', 'bytes_sent', 'bytes_received', 'fps', 'width', 'height'}


def record_diagnostics(peer, room, message):
    remote = message.get('remote_peer_id')
    if not isinstance(remote, str) or remote not in room or room[remote].role == peer.role:
        return
    safe = {'updated_at': time.time(), 'remote_peer_id': remote}
    for key, values in STATE_FIELDS.items():
        value = message.get(key)
        if isinstance(value, str) and value in values:
            safe[key] = value
    for key in NUMBER_FIELDS:
        value = message.get(key)
        if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1e15:
            safe[key] = value
    if remote not in peer.diagnostics and len(peer.diagnostics) >= 8:
        peer.diagnostics.pop(next(iter(peer.diagnostics)))
    peer.diagnostics[remote] = safe


def peer_summary(peer):
    return {'peer_id': peer.id, 'role': peer.role, 'connected_at': peer.connected_at,
        'signals_forwarded': dict(peer.signals), 'connections': list(peer.diagnostics.values())}


@router.get('/api/live/status')
async def live_status(request: Request, source_id: str):
    token = request.cookies.get('safesc_token') or request.headers.get('Authorization', '').removeprefix('Bearer ')
    if not token or not hmac.compare_digest(token, settings.app_token):
        raise HTTPException(401, 'Sign in to Palladium')
    if not get(Source, source_id):
        raise HTTPException(404, 'Source not found')
    cutoff = time.time()-120
    while recent_peers and recent_peers[0]['disconnected_at'] < cutoff:
        recent_peers.popleft()
    return {'source_id': source_id, 'server_time': time.time(),
        'peers': [peer_summary(p) for p in rooms.get(source_id, {}).values()],
        'recent_peers': [p for p in recent_peers if p['source_id'] == source_id],
        'notice': 'Transient client-reported connection diagnostics; no addresses, SDP or ICE credentials retained.'}



def ice_servers():
    servers = json.loads(settings.webrtc_ice_servers)
    if not isinstance(servers, list):
        raise ValueError('WEBRTC_ICE_SERVERS must be a JSON array')
    for server in servers:
        if not isinstance(server, dict) or not server.get('urls'):
            raise ValueError('Each ICE server needs urls')
        urls = server['urls'] if isinstance(server['urls'], list) else [server['urls']]
        if not all(isinstance(url, str) and url.startswith(('stun:', 'stuns:', 'turn:', 'turns:')) for url in urls):
            raise ValueError('Invalid ICE server URL')
    urls_text = settings.turn_urls.strip()
    secret = settings.turn_shared_secret.get_secret_value()
    if urls_text or secret:
        if not urls_text or len(secret) < 32:
            raise ValueError('TURN_URLS and a strong TURN_SHARED_SECRET must be configured together')
        urls = json.loads(urls_text) if urls_text.startswith('[') else [u.strip() for u in urls_text.split(',') if u.strip()]
        if not isinstance(urls, list) or not urls or not all(isinstance(u, str) and u.startswith(('turn:', 'turns:')) for u in urls):
            raise ValueError('TURN_URLS must contain TURN URLs')
        # Coturn REST credentials: the username expiry is authenticated by HMAC.
        # Only this one-hour credential reaches a paired camera/reviewer.
        username = f'{int(time.time())+3600}:{secrets.token_hex(8)}'
        credential = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
        servers.append({'urls': urls, 'username': username, 'credential': credential})
    return servers


async def close_slow_peer(peer):
    try:
        await asyncio.wait_for(peer.socket.close(4429, 'Signaling receiver is too slow; reconnect'), 3)
    except (RuntimeError, WebSocketDisconnect, asyncio.TimeoutError):
        pass


def enqueue(peer, message):
    # A disconnected/slow viewer cannot delay the phone or other viewers.
    if peer.closing:
        return
    if peer.queue.full():
        peer.closing = True
        asyncio.create_task(close_slow_peer(peer))
        return
    peer.queue.put_nowait(message)


@router.websocket('/ws/live')
async def live_signaling(ws: WebSocket):
    await ws.accept()
    peer = None
    room = None
    sender = None
    source_id = None
    receive = None
    try:
        hello = await asyncio.wait_for(ws.receive_json(), 10)
        if not isinstance(hello, dict):
            raise ValueError('Expected signaling hello')
        role = hello.get('role')
        if role == 'capture':
            token = hello.get('token', '')
            if not isinstance(token, str):
                raise ValueError('Expected pairing token')
            pairing = pairings.get(token)
            if not pairing or pairing['expires'] < time.time():
                await ws.close(4401, 'Pairing expired')
                return
            source_id = pairing['source_id']
        elif role == 'viewer':
            if not hmac.compare_digest(ws.cookies.get('safesc_token', ''), settings.app_token):
                await ws.close(4401, 'Sign in to Palladium')
                return
            source_id = hello.get('source_id', '')
        else:
            await ws.close(4400, 'Expected capture or viewer role')
            return
        if not isinstance(source_id, str):
            raise ValueError('Expected source ID')
        source = get(Source, source_id)
        if not source or source.kind not in ('phone', 'webcam'):
            await ws.close(4404, 'Camera source not found')
            return
        servers = ice_servers()
        room = rooms.setdefault(source_id, {})
        if role == 'capture' and any(p.role == 'capture' for p in room.values()):
            await ws.close(4409, 'Camera is already connected')
            return
        if len(room) >= 9:
            await ws.close(4429, 'Too many live viewers')
            return
        peer = Peer(secrets.token_hex(12), role, ws)
        room[peer.id] = peer
        await ws.send_json({'type': 'ready', 'peer_id': peer.id, 'role': role,
            'ice_servers': servers, 'ice_transport_policy': settings.webrtc_ice_transport_policy, 'diagnostics_supported': True, 'turn_configured': any(
                url.startswith(('turn:', 'turns:'))
                for server in servers for url in (server['urls'] if isinstance(server['urls'], list) else [server['urls']]))})
        for other in list(room.values()):
            if other is peer or other.role == role:
                continue
            enqueue(other, {'type': 'viewer_joined' if role == 'viewer' else 'capture_ready', 'peer_id': peer.id})
            enqueue(peer, {'type': 'capture_ready' if role == 'viewer' else 'viewer_joined', 'peer_id': other.id})

        async def send_messages():
            while True:
                message = await peer.queue.get()
                await asyncio.wait_for(ws.send_json(message), 10)

        sender = asyncio.create_task(send_messages())
        while True:
            # Poll lets a failed sender terminate this socket promptly as well.
            receive = asyncio.create_task(ws.receive_text())
            done, _ = await asyncio.wait([receive, sender], timeout=30, return_when=asyncio.FIRST_COMPLETED)
            if sender in done:
                receive.cancel()
                await asyncio.gather(receive, return_exceptions=True)
                sender.result()
                break
            if receive not in done:
                receive.cancel()
                await asyncio.gather(receive, return_exceptions=True)
                enqueue(peer, {'type': 'ping'})
                continue
            raw = receive.result()
            if len(raw) > 65536:
                raise ValueError('Signaling message exceeds 64 KiB')
            message = json.loads(raw)
            if not isinstance(message, dict):
                raise ValueError('Expected signaling object')
            if message.get('type') == 'pong':
                continue
            kind = message.get('type')
            if kind == 'diagnostics':
                record_diagnostics(peer, room, message)
                continue
            target_id = message.get('peer_id')
            if not isinstance(target_id, str):
                raise ValueError('Expected peer ID')
            target = room.get(target_id)
            if not target or target.role == peer.role:
                continue
            if kind == 'offer' and role == 'capture' or kind == 'answer' and role == 'viewer':
                description = message.get('description')
                if not isinstance(description, dict) or description.get('type') != kind or not isinstance(description.get('sdp'), str):
                    raise ValueError('Invalid session description')
                peer.signals[kind] = peer.signals.get(kind, 0)+1
                enqueue(target, {'type': kind, 'peer_id': peer.id, 'description': description})
            elif kind == 'candidate':
                candidate = message.get('candidate')
                if candidate is not None and not isinstance(candidate, dict):
                    raise ValueError('Invalid ICE candidate')
                peer.signals[kind] = peer.signals.get(kind, 0)+1
                enqueue(target, {'type': kind, 'peer_id': peer.id, 'candidate': candidate})
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError, asyncio.CancelledError):
        pass
    except (ValueError, TypeError):
        await ws.close(4400, 'Invalid signaling message or configuration')
    finally:
        if receive and not receive.done():
            receive.cancel()
        if sender:
            sender.cancel()
        if peer and room is not None:
            recent_peers.append({**peer_summary(peer), 'source_id': source_id, 'disconnected_at': time.time()})
            room.pop(peer.id, None)
            for other in list(room.values()):
                if not other.queue.full():
                    enqueue(other, {'type': 'peer_left', 'peer_id': peer.id})
            if not room:
                rooms.pop(source_id, None)

        with anyio.CancelScope(shield=True):
            if sender:
                await asyncio.gather(sender, return_exceptions=True)
            if receive:
                await asyncio.gather(receive, return_exceptions=True)
