/**
 * Verifies both HTTP transports against a live server:
 *   - Streamable HTTP : POST /mcp          (MCP 2025-03-26 / 2025-06-18)
 *   - Legacy HTTP+SSE : GET /sse + POST /messages
 *                       (MCP 2024-11-05 — the transport Mind+'s own
 *                        "MCP服务器" mcpserver extension emits via FastMCP)
 *
 *   node test/http-smoke.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.js');
const PORT = Number(process.env.PORT ?? 8849);
const BASE = `http://127.0.0.1:${PORT}`;

const child = spawn(process.execPath, [entry, '--transport', 'http', '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (c) => (serverLog += c));
child.stderr.on('data', (c) => (serverLog += c));

const results = [];
const record = (name, passed, detail = '') => {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function waitForPort() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${BASE}/mcp`, { method: 'OPTIONS' });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

async function postMcp(body) {
  const response = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), json: await response.json() };
}

try {
  if (!(await waitForPort())) throw new Error('server did not start');

  // ---- Streamable HTTP ----
  const init = await postMcp(
    rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-smoke', version: '0' },
    }),
  );
  record('POST /mcp initialize', init.status === 200 && init.json.result?.serverInfo?.name === 'mindplus', `session=${init.sessionId?.slice(0, 8)}…`);

  const list = await postMcp(rpc(2, 'tools/list', {}));
  const listed = list.json.result?.tools ?? [];
  const families = ['pty_open', 'ssh_connect', 'mqtt_connect', 'udp_open', 'sessions_status'].every((name) =>
    listed.some((tool) => tool.name === name),
  );
  record('POST /mcp tools/list', listed.length >= 40 && families, `${listed.length} tools`);

  const call = await postMcp(rpc(3, 'tools/call', { name: 'info', arguments: {} }));
  record('POST /mcp tools/call info', !call.json.result?.isError && JSON.stringify(call.json).includes('LINKAPPROOT'));

  // ---- Legacy HTTP+SSE ----
  const controller = new AbortController();
  const sse = await fetch(`${BASE}/sse`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  record('GET /sse opens an event stream', sse.status === 200 && (sse.headers.get('content-type') ?? '').includes('text/event-stream'));

  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  let stream = '';
  let endpoint = null;

  // Read the "endpoint" event that tells us where to POST messages.
  const endpointDeadline = Date.now() + 10000;
  while (!endpoint && Date.now() < endpointDeadline) {
    const { value, done } = await reader.read();
    if (done) break;
    stream += decoder.decode(value, { stream: true });
    const match = /event: endpoint\s*\ndata: (\S+)/.exec(stream);
    if (match) endpoint = match[1];
  }
  record('SSE endpoint event', Boolean(endpoint), endpoint ?? 'not received');

  if (endpoint) {
    const accepted = await fetch(`${BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rpc(10, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'sse-smoke', version: '0' } })),
    });
    record('POST /messages accepted', accepted.status === 202, `status=${accepted.status}`);

    let reply = null;
    const replyDeadline = Date.now() + 10000;
    while (!reply && Date.now() < replyDeadline) {
      const { value, done } = await reader.read();
      if (done) break;
      stream += decoder.decode(value, { stream: true });
      const match = /event: message\s*\ndata: (.+)/.exec(stream);
      if (match) reply = JSON.parse(match[1]);
    }
    record(
      'SSE response for initialize',
      reply?.result?.serverInfo?.name === 'mindplus' && reply?.result?.protocolVersion === '2024-11-05',
      `protocolVersion=${reply?.result?.protocolVersion}`,
    );
  }

  controller.abort();
} catch (error) {
  record('http harness', false, error.message);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  if (process.env.DEBUG) console.log(serverLog);
  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
