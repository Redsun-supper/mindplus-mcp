/**
 * Client for the DFRobot Mind+ 2.0 local service `mind-link`.
 *
 * mind-link (D:\Program Files\Mind+\apps\deps\mind-link\main.js, v2.0.2) exposes
 * two WebSocket endpoints:
 *
 *   19302  control   JSON-RPC 2.0, one request/response per connection is fine
 *   19303  transmit  WebSocket *subprotocol* demultiplexer; the subprotocol name
 *                    selects the handler:
 *                      Serialport | child_process | node-pty | ssh | UDP | MQTT | download_file
 *
 * Message shapes (verified against the bundle and against the live service):
 *   client -> server : {"jsonrpc":"2.0","id":N,"method":"...","params":{...}}
 *   server -> client : {"jsonrpc":"2.0","id":N,"result":...}  |  {"jsonrpc":"2.0","id":N,"error":...}
 *   server -> client : {"jsonrpc":"2.0","method":"data","params":...}   (notification, no id)
 *
 * There is no ambient WebSocket dependency: Node's global WebSocket (Node >= 22)
 * is used, so this package stays dependency-free.
 */

export const DEFAULT_CONTROL_PORT = 19302;
export const DEFAULT_TRANSMIT_PORT = 19303;

export class MindLinkError extends Error {
  constructor(message, { method, code } = {}) {
    super(message);
    this.name = 'MindLinkError';
    this.method = method;
    this.code = code;
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalise the several shapes mind-link uses for an error payload. */
function describeError(raw) {
  if (raw == null) return 'unknown error';
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  if (typeof raw === 'object') {
    if (typeof raw.message === 'string') return raw.message;
    if (typeof raw.error === 'string') return raw.error;
    try {
      return JSON.stringify(raw);
    } catch {
      return String(raw);
    }
  }
  return String(raw);
}

class JsonRpcSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.closed = false;
    this.ws = null;
  }

  async connect(timeoutMs) {
    if (this.ws) return this;
    const ws = this.protocols
      ? new WebSocket(this.url, this.protocols)
      : new WebSocket(this.url);
    this.ws = ws;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(
          new MindLinkError(
            `Timed out connecting to ${this.url} after ${timeoutMs}ms. ` +
              'Is Mind+ 2.0 running? (mind-link listens on 19302/19303 while Mind+ is open.)',
          ),
        );
      }, timeoutMs);

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(
          new MindLinkError(
            `Could not connect to ${this.url}. ` +
              'Start DFRobot Mind+ 2.0 first: mind-link is launched as its child process.',
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
      };

      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });

    ws.addEventListener('message', (event) => this.#onMessage(event));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new MindLinkError('mind-link closed the connection before replying'));
      }
      this.pending.clear();
      for (const listener of this.closeListeners) listener();
    });
    ws.addEventListener('error', () => {
      /* surfaced through close/pending rejections */
    });

    return this;
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message && typeof message === 'object' && 'method' in message && !('id' in message)) {
      for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }
    const entry = this.pending.get(message?.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined && message.error !== null) {
      entry.reject(new MindLinkError(describeError(message.error), { method: entry.method }));
    } else {
      entry.resolve(message.result);
    }
  }

  request(method, params, { timeoutMs = 60000 } = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new MindLinkError('mind-link connection is not open', { method }));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', method, id };
    if (params !== undefined) payload.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MindLinkError(`mind-link method "${method}" timed out after ${timeoutMs}ms`, { method }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new MindLinkError(`Failed to send "${method}": ${error.message}`, { method }));
      }
    });
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}

/**
 * A live connection on the transmit port, bound to one subprotocol.
 * Used for stateful channels (serialport, pty, ...) and for spawn-style streaming.
 */
export class TransmitSession {
  constructor(socket, protocol) {
    this.socket = socket;
    this.protocol = protocol;
  }

  static async open({ host, port, protocol, timeoutMs = 8000 }) {
    const socket = new JsonRpcSocket(`ws://${host}:${port}`, protocol);
    await socket.connect(timeoutMs);
    return new TransmitSession(socket, protocol);
  }

  request(method, params, options) {
    return this.socket.request(method, params, options);
  }

  onNotification(listener) {
    return this.socket.onNotification(listener);
  }

  onClose(listener) {
    return this.socket.onClose(listener);
  }

  close() {
    this.socket.close();
  }
}

export class MindLink {
  constructor({
    host = '127.0.0.1',
    controlPort = DEFAULT_CONTROL_PORT,
    transmitPort = DEFAULT_TRANSMIT_PORT,
    timeoutMs = 30000,
  } = {}) {
    this.host = host;
    this.controlPort = controlPort;
    this.transmitPort = transmitPort;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One JSON-RPC call on the control port (19302).
   * A fresh socket per call keeps this stateless and immune to mind-link's
   * habit of disposing the socket after a terminal event.
   */
  async control(method, params = {}, { timeoutMs = this.timeoutMs, retries = 1 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const socket = new JsonRpcSocket(`ws://${this.host}:${this.controlPort}`);
      try {
        await socket.connect(Math.min(timeoutMs, 8000));
        return await socket.request(method, params, { timeoutMs });
      } catch (error) {
        lastError = error;
        if (attempt < retries && /not open|closed the connection/.test(error.message)) {
          await delay(120);
          continue;
        }
        throw error;
      } finally {
        socket.close();
      }
    }
    throw lastError;
  }

  async openTransmit(protocol, { timeoutMs = 8000 } = {}) {
    return TransmitSession.open({
      host: this.host,
      port: this.transmitPort,
      protocol,
      timeoutMs,
    });
  }

  /**
   * Run a local command through mind-link's `child_process` channel.
   *
   * `spawn` is fire-and-forget on the wire: the RPC reply is immediate (null) and
   * the real result arrives as `stdoutData` / `stderrData` / `exit` notifications.
   * That is deterministic, so we prefer it over `exec`, whose reply races with the
   * socket teardown that mind-link performs on process exit.
   */
  async runCommand({
    cmd,
    args = [],
    cwd,
    env,
    timeoutMs = 60000,
    onStdout,
    onStderr,
  } = {}) {
    if (!cmd) throw new MindLinkError('cmd is required');
    const session = await this.openTransmit('child_process', { timeoutMs: 8000 });
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let spawnError = null;
    let timedOut = false;
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

    session.onNotification((method, params) => {
      if (method === 'stdoutData') {
        const text = typeof params === 'string' ? params : String(params ?? '');
        stdout += text;
        onStdout?.(text);
      } else if (method === 'stderrData') {
        const text = typeof params === 'string' ? params : String(params ?? '');
        stderr += text;
        onStderr?.(text);
      } else if (method === 'error') {
        spawnError = describeError(params);
      } else if (method === 'exit') {
        exitCode = typeof params === 'number' ? params : null;
        finish();
      }
    });
    session.onClose(finish);

    const options = { windowsHide: true };
    if (cwd) options.cwd = cwd;
    if (env) options.env = env;

    await session.request('spawn', { cmd, args, options }, { timeoutMs: 8000 });

    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        session.request('kill', { signal: 'SIGTERM' }).catch(() => {});
        resolve();
      }, timeoutMs);
    });

    await Promise.race([done, guard]);
    clearTimeout(timer);
    session.close();

    if (spawnError && exitCode === null && !stdout && !stderr) {
      throw new MindLinkError(`mind-link could not start "${cmd}": ${spawnError}`);
    }
    return {
      cmd,
      args,
      exitCode: timedOut ? null : exitCode,
      timedOut,
      stdout,
      stderr,
    };
  }

  async serialList() {
    const ports = await this.control('serialList', {});
    return Array.isArray(ports) ? ports : [];
  }

  async pathInfo() {
    return this.control('getPathInfo', {});
  }

  async homedir() {
    return this.control('getHomedir', {});
  }
}

export { describeError };
