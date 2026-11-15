import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from './server.mjs';
import {gzipSync} from 'node:zlib';

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, handler) {
  const dist = await mkdtemp(join(tmpdir(), 'safesc-gateway-'));
  await writeFile(join(dist, 'index.html'), '<h1>Palladium</h1>');
  await mkdir(join(dist, 'command', 'assets'), {recursive:true});
  await writeFile(join(dist, 'command', 'index.html'), '<h1>Palladium Command</h1>');
  await writeFile(join(dist, 'command', 'assets', 'worker.js'), '/* map worker */');
  const backend = http.createServer(handler || ((_req, res) => res.end('upstream')));
  const backendOrigin = await listen(backend);
  const gateway = createGateway({backendOrigin, dist});
  const origin = await listen(gateway);
  t.after(async () => {
    gateway.closeStreams(); gateway.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise(r => gateway.close(r)), new Promise(r => backend.close(r))]);
    await rm(dist, {recursive:true});
  });
  return {gateway, backend, origin};
}

test('serves phone SPA and readiness without backend, excludes private files', async t => {
  const {origin} = await fixture(t);
  assert.match(await (await fetch(origin + '/capture')).text(), /Palladium/);
  assert.equal((await fetch(origin + '/')).headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal((await fetch(origin + '/_health')).status, 200);
  const home = await fetch(origin + '/', {redirect:'manual'});
  assert.equal(home.status, 302); assert.equal(home.headers.get('location'), '/command/');
  for (const path of ['/.env', '/data/private.json', '/%2eenv', '/missing.js']) {
    assert.equal((await fetch(origin + path)).status, 404, path);
  }
  assert.equal((await fetch(origin + '/', {method:'POST'})).status, 405);
});

test('serves the command dashboard, officer links and command assets', async t => {
  const {origin} = await fixture(t);
  for (const path of ['/command', '/command/', '/command/?unit=officer-3&room=example']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), '<h1>Palladium Command</h1>', path);
  }
  const worker = await fetch(origin + '/command/assets/worker.js');
  assert.equal(await worker.text(), '/* map worker */');
  assert.match(worker.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(origin + '/command/assets/missing.js')).status, 404);
  assert.equal(await (await fetch(origin + '/commander')).text(), '<h1>Palladium</h1>');
});

test('streams upload body, auth cookies, compressed responses and media ranges', async t => {
  const {origin} = await fixture(t, async (req, res) => {
    if (req.url === '/api/login') {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.equal(body, '{"token":"test-only"}');
      assert.equal(req.headers['x-forwarded-host'], undefined);
      res.setHeader('Set-Cookie', 'safesc_token=test-only; HttpOnly; Secure; SameSite=Strict; Path=/');
      res.setHeader('Content-Encoding', 'gzip');
      return res.end(gzipSync('{"ok":true}'));
    }
    assert.equal(req.headers.cookie, 'safesc_token=test-only');
    assert.equal(req.headers.range, 'bytes=3-5');
    res.writeHead(206, {'Content-Range':'bytes 3-5/10', 'Content-Type':'video/mp4'});
    res.end('345');
  });
  const login = await fetch(origin + '/api/login', {method:'POST', body:'{"token":"test-only"}',
    headers:{'x-forwarded-host':'attacker.invalid'}});
  assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.deepEqual(await login.json(), {ok:true});
  const media = await fetch(origin + '/api/video', {headers:{cookie:'safesc_token=test-only', range:'bytes=3-5'}});
  assert.equal(media.status, 206);
  assert.equal(media.headers.get('content-range'), 'bytes 3-5/10');
  assert.equal(media.headers.get('cache-control'), 'private, no-store');
  assert.equal(await media.text(), '345');
});

test('passes backend auth failures and reports unreachable workers', async t => {
  const {origin, backend} = await fixture(t, (_req, res) => { res.writeHead(401); res.end('Sign in'); });
  assert.equal((await fetch(origin + '/api/health')).status, 401);
  backend.closeAllConnections(); await new Promise(r => backend.close(r));
  assert.equal((await fetch(origin + '/api/health')).status, 502);
});

test('relays capture and dispatch WebSockets, rejects unrelated paths and origins', async t => {
  const {origin, backend} = await fixture(t);
  const roomPath = '/ws/dispatch/abcDEF0123_-abcDEF0123';
  const forwarded = [];
  backend.on('upgrade', (req, socket, head) => {
    forwarded.push(req.url);
    assert.equal(req.headers.cookie, 'safesc_token=test-only');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  const socket = await new Promise((resolve, reject) => {
    const request = http.request(origin + '/ws/live', {headers:{Connection:'Upgrade', Upgrade:'websocket',
      Origin:origin, Cookie:'safesc_token=test-only'}});
    request.on('upgrade', (_response, socket) => resolve(socket)); request.on('error', reject); request.end();
  });
  const binary = Buffer.from([0x82, 0x83, 1, 2, 3, 4, 42, 43, 44]);
  for (const path of ['/ws/capture', roomPath]) {
    const socket = await new Promise((resolve, reject) => {
      const request = http.request(origin + path, {headers:{Connection:'Upgrade', Upgrade:'websocket',
        Origin:origin, Cookie:'safesc_token=test-only'}});
      request.on('upgrade', (_response, socket) => resolve(socket));
      request.on('response', response => { response.resume(); reject(new Error(`Unexpected status ${response.statusCode}`)); });
      request.on('error', reject); request.end();
    });
    const data = once(socket, 'data'); socket.write(binary);
    assert.deepEqual((await data)[0], binary); socket.destroy();
  }
  assert.deepEqual(forwarded, ['/ws/live', '/ws/capture', roomPath]);
  for (const [path, from, expected] of [
    ['/ws/capture', 'https://evil.invalid', 403],
    [roomPath, 'https://evil.invalid', 403],
    ['/ws/admin', origin, 404],
    ['/ws/dispatch/short', origin, 404],
    [roomPath + '/extra', origin, 404],
  ]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request(origin + path, {headers:{Connection:'Upgrade', Upgrade:'websocket', Origin:from}});
      request.on('response', response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); request.end();
    });
    assert.equal(status, expected);
  }
});

test('requires a fixed HTTPS worker origin and forbids credentials or URL paths', () => {
  for (const backendOrigin of ['http://example.com', 'https://user:password@example.com', 'https://example.com/api', 'https://example.com/?token=x']) {
    assert.throws(() => createGateway({backendOrigin}));
  }
});
