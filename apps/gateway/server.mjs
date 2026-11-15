// Replit hosts only this UI gateway. Models, credentials and storage stay on Runpod.
import http from 'node:http';
import https from 'node:https';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultDist = fileURLToPath(new URL('../web/dist/', import.meta.url));
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'];
const mime = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
  '.jpg':'image/jpeg', '.ico':'image/x-icon', '.woff2':'font/woff2', '.json':'application/json'};

function cleanHeaders(headers) {
  const result = {...headers};
  const connection = String(headers.connection || '').split(',').map(x => x.trim().toLowerCase());
  for (const name of [...hopHeaders, ...connection]) delete result[name];
  return result;
}

function reply(res, status, message) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
  res.end(JSON.stringify({detail:message}));
}

export function createGateway({backendOrigin = process.env.PALLADIUM_BACKEND_ORIGIN || process.env.SAFESC_BACKEND_ORIGIN, dist = defaultDist} = {}) {
  if (!backendOrigin) throw new Error('Set PALLADIUM_BACKEND_ORIGIN to the Runpod HTTPS origin');
  const backend = new URL(backendOrigin);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(backend.hostname);
  if ((backend.protocol !== 'https:' && !(local && backend.protocol === 'http:')) ||
      backend.username || backend.password || backend.pathname !== '/' || backend.search || backend.hash) {
    throw new Error('PALLADIUM_BACKEND_ORIGIN must be an HTTPS origin (HTTP allowed only for localhost)');
  }
  const transport = backend.protocol === 'https:' ? https : http;
  const root = resolve(dist);
  const sockets = new Set();

  function upstream(req, websocket = false) {
    const headers = cleanHeaders(req.headers);
    headers.host = backend.host; // Runpod proxy routes by Host and TLS SNI.
    // Never trust public forwarding headers or send Replit-specific identity headers to the worker.
    for (const name of Object.keys(headers)) {
      if (name.startsWith('x-forwarded-') || name.startsWith('x-replit-') || name === 'forwarded') delete headers[name];
    }
    if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
    return transport.request({protocol:backend.protocol, hostname:backend.hostname, port:backend.port,
      method:req.method, path:req.url, headers});
  }

  const server = http.createServer(async (req, res) => {
    // Reject absolute-form URLs; the client cannot select another upstream host.
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, 'Invalid request path');
    if (req.url === '/_health') return reply(res, 200, 'UI gateway ready');
    // Palladium's front door is the 3D command app; the reviewer app keeps /capture for phone cameras.
    if (['GET', 'HEAD'].includes(req.method) && /^\/(\?|$)/.test(req.url)) {
      res.writeHead(302, {Location: '/command/' + req.url.slice(1), 'Cache-Control': 'no-store'}); return res.end();
    }
    if (/^\/api(?:\/|\?|$)/.test(req.url)) {
      const remote = upstream(req);
      remote.setTimeout(15 * 60_000, () => remote.destroy(new Error('Upstream timeout')));
      remote.on('response', response => {
        const headers = cleanHeaders(response.headers);
        headers['cache-control'] = 'private, no-store';
        res.writeHead(response.statusCode || 502, headers);
        response.on('error', () => res.destroy());
        response.pipe(res); // Includes uploads, media ranges, cookies and compressed API responses.
      });
      remote.on('error', () => reply(res, 502, 'GPU backend unavailable. Check Runpod status and retry.'));
      req.on('aborted', () => remote.destroy());
      res.on('close', () => { if (!res.writableFinished) remote.destroy(); });
      req.pipe(remote);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) return reply(res, 405, 'Method not allowed');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://gateway.local').pathname); }
    catch { return reply(res, 400, 'Invalid request path'); }
    if (pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.') && p !== '')) {
      return reply(res, 404, 'Not found');
    }
    const command = pathname === '/command' || pathname.startsWith('/command/');
    let filename = resolve(root, '.' + pathname);
    if (!filename.startsWith(root + sep) && filename !== root) return reply(res, 404, 'Not found');
    let info = await stat(filename).catch(() => null);
    if (!info?.isFile()) {
      if (extname(pathname)) return reply(res, 404, 'Not found');
      filename = resolve(root, command ? 'command/index.html' : 'index.html');
      info = await stat(filename).catch(() => null);
    }
    if (!info?.isFile()) return reply(res, 503, 'UI build missing. Run npm run build first.');
    res.writeHead(200, {'Content-Type':mime[extname(filename)] || 'application/octet-stream',
      'Content-Length':info.size, 'X-Content-Type-Options':'nosniff',
      // OSM tiles require a Referer. Cross-origin requests disclose only the
      // public site origin; pairing fragments and review paths stay private.
      'Referrer-Policy':'strict-origin-when-cross-origin',
      'Cache-Control':/^\/(?:command\/)?assets\//.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache'});
    if (req.method === 'HEAD') return res.end();
    createReadStream(filename).on('error', () => res.destroy()).pipe(res);
  });

  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    const pathname = req.url?.split('?')[0] || '';
    const allowed = ['/ws/events', '/ws/capture', '/ws/preview', '/ws/live'].includes(pathname) || /^\/ws\/dispatch\/[A-Za-z0-9_-]{22,64}$/.test(pathname);
    if (!allowed || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      reject('404 Not Found'); return;
    }
    // Same-origin browser sockets only. Non-browser clients may omit Origin; backend auth still applies.
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { reject('403 Forbidden'); return; }
      if (!['https:', 'http:'].includes(origin.protocol) || origin.host !== req.headers.host) {
        reject('403 Forbidden'); return;
      }
    }
    const remote = upstream(req, true);
    const timer = setTimeout(() => remote.destroy(), 30_000);
    socket.on('error', () => remote.destroy());
    socket.on('close', () => remote.destroy());
    remote.on('error', () => { clearTimeout(timer); reject('502 Bad Gateway'); });
    remote.on('response', response => {
      clearTimeout(timer); response.resume(); reject(`${response.statusCode || 502} Backend rejected connection`);
    });
    remote.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      clearTimeout(timer);
      sockets.add(socket); sockets.add(upstreamSocket);
      socket.on('close', () => { sockets.delete(socket); upstreamSocket.destroy(); });
      upstreamSocket.on('close', () => { sockets.delete(upstreamSocket); socket.destroy(); });
      upstreamSocket.on('error', () => socket.destroy());
      const lines = [`HTTP/1.1 ${response.statusCode} Switching Protocols`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.setTimeout(0); upstreamSocket.setTimeout(0);
      socket.pipe(upstreamSocket); upstreamSocket.pipe(socket);
    });
    remote.end();
  });
  server.closeStreams = () => { for (const socket of sockets) socket.destroy(); };
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createGateway();
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`Palladium UI gateway listening on ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.closeStreams(); server.close(() => process.exit(0));
  });
}
