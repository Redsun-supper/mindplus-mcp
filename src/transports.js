/**
 * Transports for the MCP server.
 *
 *   stdio             newline-delimited JSON-RPC on stdin/stdout (MCP standard)
 *   streamable-http   POST /mcp  -> application/json  (MCP 2025-03-26 / 2025-06-18)
 *   sse               GET /sse + POST /messages       (MCP 2024-11-05 — the transport
 *                                                      FastMCP exposes as "sse")
 *
 * Serving all three keeps this bridge consumable from both directions: DSH (or any
 * MCP client) over stdio/streamable-http, and programs written with Mind+'s own
 * "MCP服务器" (mcpserver) extension — which offers exactly http and sse, no stdio —
 * over streamable-http/sse.
 *
 * NOTE: that Mind+'s extension *does* emit this exact SSE handshake is a design
 * alignment, not an observation — verifying it needs the extension running inside
 * Mind+, which is a GUI step. Treat the Mind+-side compatibility as untested.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const LOG_PREFIX = '[mindplus-mcp]';

function log(...args) {
  process.stderr.write(`${LOG_PREFIX} ${args.join(' ')}\n`);
}

export function serveStdio(server) {
  let buffer = '';
  process.stdin.setEncoding('utf8');

  const handleLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: `Parse error: ${error.message}` },
      });
      return;
    }
    const response = await server.handleMessage(message);
    if (response) write(response);
  };

  const write = (payload) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      handleLine(line).catch((error) => log('unhandled error:', error.message));
    }
  });

  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('error', () => process.exit(0));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, authorization, mcp-protocol-version, mcp-session-id, accept, last-event-id',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

export function createHttpServer(server, { sessions } = {}) {
  const sseSessions = sessions ?? new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // ---- Streamable HTTP -------------------------------------------------
    if (url.pathname === '/mcp' || url.pathname === '/') {
      if (req.method === 'GET') {
        // We do not offer a server-initiated stream; tell the client plainly.
        sendJson(res, 405, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'This server does not offer a standalone GET stream; POST JSON-RPC to /mcp' },
        });
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(204, { ...CORS_HEADERS, 'mcp-session-id': req.headers['mcp-session-id'] ?? '' });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed' } });
        return;
      }

      let message;
      try {
        message = JSON.parse(await readBody(req));
      } catch (error) {
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
        return;
      }

      const sessionId = req.headers['mcp-session-id'] ?? randomUUID();
      const response = await server.handleMessage(message);
      if (!response) {
        res.writeHead(202, { ...CORS_HEADERS, 'mcp-session-id': sessionId });
        res.end();
        return;
      }
      sendJson(res, 200, response, { 'mcp-session-id': sessionId });
      return;
    }

    // ---- Legacy HTTP+SSE -------------------------------------------------
    if (url.pathname === '/sse' && req.method === 'GET') {
      const sessionId = randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        ...CORS_HEADERS,
      });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

      const keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          /* ignore */
        }
      }, 15000);

      sseSessions.set(sessionId, { res, keepAlive });
      const cleanup = () => {
        clearInterval(keepAlive);
        sseSessions.delete(sessionId);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    if (url.pathname === '/messages' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? sseSessions.get(sessionId) : null;
      if (!session) {
        sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown or expired sessionId; open GET /sse first' } });
        return;
      }
      let message;
      try {
        message = JSON.parse(await readBody(req));
      } catch (error) {
        res.writeHead(400, CORS_HEADERS);
        res.end(`Parse error: ${error.message}`);
        return;
      }
      res.writeHead(202, CORS_HEADERS);
      res.end('Accepted');
      const response = await server.handleMessage(message);
      if (response) {
        try {
          session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        } catch {
          /* client gone */
        }
      }
      return;
    }

    sendJson(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: `No route for ${req.method} ${url.pathname}` } });
  });

  httpServer.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return httpServer;
}

export function serveHttp(server, { host = '127.0.0.1', port = 8848 } = {}) {
  const httpServer = createHttpServer(server);
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      log(`listening on http://${host}:${port}`);
      log(`  streamable-http : POST http://${host}:${port}/mcp`);
      log(`  sse             : GET  http://${host}:${port}/sse  +  POST /messages`);
      resolve(httpServer);
    });
  });
}

export { log };
