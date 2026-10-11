/**
 * Stateful sessions over mind-link's transmit port (19303).
 *
 * mind-link demultiplexes that port by WebSocket *subprotocol*, and the
 * subprotocol name selects the handler:
 *
 *   Serialport | child_process | node-pty | ssh | UDP | MQTT | download_file
 *
 * Each session below owns exactly one WebSocket and translates mind-link's
 * `{jsonrpc:"2.0",method,params}` notifications (no `id`) into something an MCP
 * tool can consume. Method names, parameter shapes and notification names are
 * taken verbatim from main.js (v2.0.2) — see README.md for the tables.
 */

import { MindLinkError, describeError } from './mindlink.js';

const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/**
 * mind-link is inconsistent about binary payloads: the serial handler sends
 * base64 strings, while the ssh handler sends `Array.from(buffer)` (an array of
 * byte numbers). Normalise both to a Buffer.
 */
function bytesToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  if (value && typeof value === 'object' && Array.isArray(value.data)) return Buffer.from(value.data);
  return Buffer.alloc(0);
}

/** A FIFO of inbound notifications plus the waiters that block on it. */
class WaitQueue {
  constructor() {
    this.items = [];
    this.total = 0;
    this.waiters = new Set();
  }

  push(item) {
    this.items.push(item);
    this.total += 1;
    this.wake();
  }

  /** Re-evaluate every waiter's predicate (called after any state change). */
  wake() {
    for (const waiter of this.waiters) {
      if (waiter.predicate()) waiter.resolve();
    }
  }

  drain() {
    const items = this.items;
    this.items = [];
    return items;
  }

  waitFor(predicate, timeoutMs) {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = {
        predicate,
        resolve: () => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve();
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }
}

/** Shared behaviour for every session: one socket, one inbound queue. */
class TransmitChannel {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.lastError = null;
    this.queue = new WaitQueue();
    socket.onClose(() => {
      this.closed = true;
      this.queue.wake();
      this.onChannelClose();
    });
  }

  onChannelClose() {}

  request(method, params, options) {
    return this.socket.request(method, params, options);
  }

  close() {
    this.socket.close();
  }

  /** Drain queued notifications, waiting up to timeoutMs for the first one. */
  async read({ timeoutMs = 1000 } = {}) {
    if (this.queue.items.length === 0 && !this.closed) {
      await this.queue.waitFor(() => this.queue.items.length > 0 || this.closed, timeoutMs);
    }
    return this.queue.drain();
  }
}

// ---------------------------------------------------------------------------
// Serialport
//
// Inbound bytes arrive as `data` notifications whose params is a base64 string.
// ---------------------------------------------------------------------------

export class SerialSession extends TransmitChannel {
  constructor({ port, socket, config }) {
    super(socket);
    this.port = port;
    this.config = config;
    this.chunks = [];
    this.byteCount = 0;
    this.receivedTotal = 0;
    this.opened = false;
    this.openedAt = null;
    this.openWaiters = new Set();

    socket.onNotification((method, params) => {
      if (method === 'data') {
        const buffer = Buffer.from(typeof params === 'string' ? params : String(params ?? ''), 'base64');
        this.chunks.push(buffer);
        this.byteCount += buffer.length;
        this.receivedTotal += buffer.length;
        this.queue.wake();
      } else if (method === 'open') {
        this.opened = true;
        this.openedAt = new Date().toISOString();
        for (const waiter of this.openWaiters) waiter.resolve();
        this.openWaiters.clear();
      } else if (method === 'error') {
        this.lastError = typeof params === 'string' ? params : text(params);
        for (const waiter of this.openWaiters) waiter.reject(new MindLinkError(this.lastError));
        this.openWaiters.clear();
        this.queue.wake();
      } else if (method === 'close') {
        // mind-link reports a closed port as `close` (SerialPort's own "close"
        // event -> reportClose()); a bad port surfaces as `error` instead. If
        // this arrives while serial_open is still waiting, fail immediately
        // rather than waiting out the whole openTimeoutMs.
        this.closed = true;
        this.opened = false;
        for (const waiter of this.openWaiters) {
          waiter.reject(
            new MindLinkError(this.lastError ?? `mind-link closed ${this.port} before it reported "open"`),
          );
        }
        this.openWaiters.clear();
        this.queue.wake();
      }
    });
  }

  onChannelClose() {
    this.opened = false;
    for (const waiter of this.openWaiters) {
      waiter.reject(new MindLinkError('mind-link closed the serial connection'));
    }
    this.openWaiters.clear();
  }

  waitForOpen(timeoutMs = 5000) {
    if (this.opened) return Promise.resolve();
    if (this.lastError) return Promise.reject(new MindLinkError(this.lastError));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.openWaiters.add(waiter);
      setTimeout(() => {
        if (this.openWaiters.delete(waiter)) {
          reject(
            new MindLinkError(
              `Timed out waiting for ${this.port} to report "open" after ${timeoutMs}ms` +
                (this.lastError ? ` (last error: ${this.lastError})` : ''),
            ),
          );
        }
      }, timeoutMs);
    });
  }

  drain({ maxBytes } = {}) {
    let chunks = this.chunks;
    if (maxBytes && this.byteCount > maxBytes) {
      const joined = Buffer.concat(chunks);
      const head = joined.subarray(0, maxBytes);
      const tail = joined.subarray(maxBytes);
      this.chunks = [tail];
      this.byteCount = tail.length;
      chunks = [head];
    } else {
      this.chunks = [];
      this.byteCount = 0;
    }
    const buffer = Buffer.concat(chunks);
    return {
      base64: buffer.toString('base64'),
      text: buffer.toString('utf8'),
      bytes: buffer.length,
    };
  }

  async read({ timeoutMs = 1000, maxBytes } = {}) {
    if (this.byteCount === 0 && !this.closed) {
      await this.queue.waitFor(() => this.byteCount > 0 || this.closed, timeoutMs);
    }
    return this.drain({ maxBytes });
  }

  async write(data, encoding = 'utf8') {
    const buffer = encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
    // mind-link passes the raw `params` value to Buffer.from(params, 'base64'),
    // so `params` must be the base64 string itself, not an object.
    await this.request('write', buffer.toString('base64'), { timeoutMs: 8000 });
    return buffer.length;
  }

  async close() {
    try {
      await this.request('close', {}, { timeoutMs: 5000 });
    } catch {
      /* the socket is disposed by mind-link either way */
    }
    super.close();
  }

  status() {
    return {
      port: this.port,
      config: this.config,
      opened: this.opened,
      closed: this.closed,
      openedAt: this.openedAt,
      bufferedBytes: this.byteCount,
      receivedTotalBytes: this.receivedTotal,
      lastError: this.lastError,
    };
  }
}

// ---------------------------------------------------------------------------
// node-pty
//
//   spawn({cmd,args,options})   fire-and-forget (reply is null)
//   write(<string>)             params is the raw string
//   resize({cols,rows})
//   kill() / pause() / resume()
//   notifications: data(<string>), exit({exitCode,signal})
// ---------------------------------------------------------------------------

export class PtySession extends TransmitChannel {
  constructor({ id, socket, config }) {
    super(socket);
    this.id = id;
    this.config = config;
    this.openedAt = new Date().toISOString();
    this.exited = false;
    this.exitInfo = null;
    this.receivedTotal = 0;

    socket.onNotification((method, params) => {
      if (method === 'data') {
        this.receivedTotal += 1;
        this.queue.push({ type: 'data', data: typeof params === 'string' ? params : text(params) });
      } else if (method === 'exit') {
        this.exited = true;
        this.exitInfo = params ?? null;
        this.queue.wake();
      }
    });
  }

  async write(data) {
    await this.request('write', String(data), { timeoutMs: 8000 });
    return String(data).length;
  }

  status() {
    return {
      id: this.id,
      config: this.config,
      openedAt: this.openedAt,
      exited: this.exited,
      exitInfo: this.exitInfo,
      closed: this.closed,
      bufferedChunks: this.queue.items.length,
      receivedTotalChunks: this.receivedTotal,
      lastError: this.lastError,
    };
  }
}

// ---------------------------------------------------------------------------
// ssh
//
//   connect(<ssh2 ConnectConfig>)   notifications: ready | error | close
//   shell() / shellWrite(<string>)  notifications: shell-data([bytes]) | shell-close
//   exec({cmd})                     notifications: exec-data | exec-stderr-data | exec-close
//   execWrite(<string>) / execSignal(<string>) / execClose()
//   sftp() then readdir/mkdir/rmdir/readfile/writefile/unlink/stat/rename
//
// NOTE: mind-link's reportError() reads `e.messgae` (a typo), so the `error`
// notification for ssh carries `undefined` as its params. Callers must not rely
// on an error message being present.
// ---------------------------------------------------------------------------

export class SshSession extends TransmitChannel {
  constructor({ id, socket, config }) {
    super(socket);
    this.id = id;
    this.config = {
      host: config?.host ?? null,
      port: config?.port ?? null,
      username: config?.username ?? null,
    };
    this.ready = false;
    this.shellOpen = false;
    this.sftpReady = false;
    this.receivedTotal = 0;

    socket.onNotification((method, params) => {
      switch (method) {
        case 'ready':
          this.ready = true;
          this.queue.wake();
          break;
        case 'error':
          this.lastError = describeError(params);
          this.queue.wake();
          break;
        case 'close':
          this.closed = true;
          this.queue.wake();
          break;
        case 'shell-data':
          this.receivedTotal += 1;
          this.queue.push({ type: 'shell', ...bufferChunk(params) });
          break;
        case 'shell-close':
          this.shellOpen = false;
          this.queue.push({ type: 'shell-close' });
          break;
        default:
          break;
      }
    });
  }

  async exec({ cmd, timeoutMs = 60000 }) {
    if (!this.ready) {
      throw new MindLinkError(`SSH session ${this.id} is not connected (call ssh_connect first)`);
    }
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let settled = false;
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      settle();
    };

    const off = this.socket.onNotification((method, params) => {
      if (method === 'exec-data') stdout += bytesToBuffer(params).toString('utf8');
      else if (method === 'exec-stderr-data') stderr += bytesToBuffer(params).toString('utf8');
      else if (method === 'exec-close') {
        exitCode = typeof params === 'number' ? params : null;
        finish();
      }
    });

    try {
      await this.request('exec', { cmd }, { timeoutMs: 15000 });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.request('execSignal', 'SIGTERM').catch(() => {});
        finish();
      }, timeoutMs);
      await done;
      clearTimeout(timer);
      return { cmd, stdout, stderr, exitCode, timedOut };
    } finally {
      off();
    }
  }

  /** Open the interactive shell stream once; later calls are no-ops. */
  async ensureShell() {
    if (this.shellOpen) return;
    await this.request('shell', {}, { timeoutMs: 15000 });
    this.shellOpen = true;
  }

  /** Open the SFTP subsystem once; later calls are no-ops. */
  async ensureSftp() {
    if (this.sftpReady) return;
    await this.request('sftp', {}, { timeoutMs: 15000 });
    this.sftpReady = true;
  }

  status() {
    return {
      id: this.id,
      config: this.config,
      ready: this.ready,
      shellOpen: this.shellOpen,
      sftpReady: this.sftpReady,
      closed: this.closed,
      bufferedChunks: this.queue.items.length,
      receivedTotalChunks: this.receivedTotal,
      lastError: this.lastError,
    };
  }
}

function bufferChunk(value) {
  const buffer = bytesToBuffer(value);
  return { base64: buffer.toString('base64'), text: buffer.toString('utf8'), bytes: buffer.length };
}

// ---------------------------------------------------------------------------
// MQTT
//
//   connect({url,options})            notifications: connect | error | close |
//                                                  reconnect | offline
//   subscribe({topic,options})
//   publish({topic,message,options})
//   end()
//   notifications: message({topic,message})
// ---------------------------------------------------------------------------

export class MqttSession extends TransmitChannel {
  constructor({ id, socket, url }) {
    super(socket);
    this.id = id;
    this.url = url;
    this.connected = false;
    this.reconnects = 0;
    this.receivedTotal = 0;

    socket.onNotification((method, params) => {
      switch (method) {
        case 'connect':
          this.connected = true;
          this.queue.wake();
          break;
        case 'error':
          this.lastError = describeError(params);
          this.queue.wake();
          break;
        case 'reconnect':
          this.reconnects += 1;
          this.queue.wake();
          break;
        case 'offline':
          this.connected = false;
          this.queue.wake();
          break;
        case 'close':
          this.connected = false;
          this.closed = true;
          this.queue.wake();
          break;
        case 'message':
          this.receivedTotal += 1;
          this.queue.push({
            topic: params?.topic ?? null,
            message: params?.message ?? null,
          });
          break;
        default:
          break;
      }
    });
  }

  status() {
    return {
      id: this.id,
      url: this.url,
      connected: this.connected,
      reconnects: this.reconnects,
      closed: this.closed,
      bufferedMessages: this.queue.items.length,
      receivedTotalMessages: this.receivedTotal,
      lastError: this.lastError,
    };
  }
}

// ---------------------------------------------------------------------------
// UDP
//
//   createSocket(<"udp4"|"udp6">)      notifications: open | error | close
//   bindPort({port,ip})
//   sendUdpMessage({message,offset,length,port,address})
//   setBroadcast(<boolean>)
//   closeUdp()
//   notifications: message({message:<base64>,rinfo:{address,port}})
//
// NOTE: mind-link wires reportOpen() to the *message* listener of
// dgram.createSocket(), so `open` fires on the first inbound datagram rather
// than on bind. Treat a resolved bindPort() as "ready".
// ---------------------------------------------------------------------------

export class UdpSession extends TransmitChannel {
  constructor({ id, socket, type }) {
    super(socket);
    this.id = id;
    this.type = type;
    this.opened = false;
    this.bound = null;
    this.receivedTotal = 0;

    socket.onNotification((method, params) => {
      switch (method) {
        case 'open':
          this.opened = true;
          this.queue.wake();
          break;
        case 'error':
          this.lastError = describeError(params);
          this.queue.wake();
          break;
        case 'close':
          this.closed = true;
          this.queue.wake();
          break;
        case 'message': {
          this.receivedTotal += 1;
          const buffer = bytesToBuffer(params?.message ?? '');
          this.queue.push({
            base64: buffer.toString('base64'),
            text: buffer.toString('utf8'),
            bytes: buffer.length,
            rinfo: params?.rinfo ?? null,
          });
          break;
        }
        default:
          break;
      }
    });
  }

  status() {
    return {
      id: this.id,
      type: this.type,
      opened: this.opened,
      bound: this.bound,
      closed: this.closed,
      bufferedMessages: this.queue.items.length,
      receivedTotalMessages: this.receivedTotal,
      lastError: this.lastError,
    };
  }
}
