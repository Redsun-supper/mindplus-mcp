/**
 * Tool catalog for mindplus-mcp.
 *
 * Every tool is a thin, typed wrapper over a mind-link JSON-RPC method. The
 * method names and parameter shapes below are taken from the mind-link bundle
 * (2.0.2) and verified against the live service — see README.md for the table.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MindLink } from './mindlink.js';
import { SerialSession, PtySession, SshSession, MqttSession, UdpSession } from './sessions.js';
import { GuiHost, guiSupported, defaultShotDir } from './gui.js';
import { resolveVisionConfig, createVisionClient, describeVisionConfig } from './vision.js';
import {
  grabScreen,
  resolveArea,
  locateOnScreen,
  runVisionLoop,
  findImageOnScreen,
  findColorOnScreen,
  DEFAULT_ACTIONS,
} from './automation.js';
import { decodePng, encodePng, crop, resize, parseColor, annotate, diffImages } from './image.js';

/**
 * Mind+'s per-user data directory. Mirrors mind-link's own getAppDataPath()
 * (bundle module 295) — the ARDUINO_PATH it derives is <data>/Arduino (module 610):
 *   win32   %HOMEDIR%\AppData\Local\mind+
 *   darwin  %HOMEDIR%/Library/mind+
 *   linux   %HOMEDIR%/.mind+
 */
function mindPlusDataDir(home) {
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'mind+');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'mind+');
  return path.join(home, '.mind+');
}

const text = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const ok = (payload) => ({ content: [{ type: 'text', text: text(payload) }] });
const fail = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
/** Same as ok(), but also attaches the image so the client can look at it. */
const okImage = (payload, base64, mimeType = 'image/png') => ({
  content: [
    { type: 'text', text: text(payload) },
    { type: 'image', data: base64, mimeType },
  ],
});
/** Wrap a handler so thrown errors become MCP tool errors instead of crashes. */
const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (error) {
    return fail(error?.message ?? String(error));
  }
};

/** %HOMEDIR% / %APPROOT% are expanded by mind-link itself (module 610). */
const HOME = '%HOMEDIR%';
const APPROOT = '%APPROOT%';

export class MindPlusTools {
  constructor({ host = '127.0.0.1', controlPort, transmitPort, timeoutMs = 30000, shotDir, vision, visionConfigFile } = {}) {
    this.link = new MindLink({ host, controlPort, transmitPort, timeoutMs });
    this.serialSessions = new Map();
    this.ptySessions = new Map();
    this.sshSessions = new Map();
    this.mqttSessions = new Map();
    this.udpSessions = new Map();

    // GUI automation talks to a local PowerShell host, not to mind-link, so it
    // keeps working even when Mind+ is closed.
    this.shotDir = shotDir ?? defaultShotDir();
    this.gui = new GuiHost({ timeoutMs: Math.max(timeoutMs, 30000), shotDir: this.shotDir });

    // The recognition layer. A provider of "none" is fine: the local matchers
    // (image_find / pixel_find) still work, only vision_* needs a model.
    // A broken vision config must never stop the server from starting, so the
    // failure is recorded and reported by the vision_config tool instead.
    this.visionConfigError = null;
    try {
      this.visionConfig = resolveVisionConfig({ file: visionConfigFile, overrides: vision ?? {} });
    } catch (error) {
      this.visionConfigError = error.message;
      this.visionConfig = resolveVisionConfig({ overrides: { provider: 'none' } });
    }
    this.vision = createVisionClient(this.visionConfig);
  }

  async shutdown() {
    await this.gui.stop().catch(() => {});
    for (const session of this.serialSessions.values()) {
      await session.close().catch(() => {});
    }
    for (const session of this.ptySessions.values()) {
      await session.request('kill', {}, { timeoutMs: 3000 }).catch(() => {});
      session.close();
    }
    for (const session of this.sshSessions.values()) {
      await session.request('end', {}, { timeoutMs: 3000 }).catch(() => {});
      session.close();
    }
    for (const session of this.mqttSessions.values()) {
      await session.request('end', {}, { timeoutMs: 3000 }).catch(() => {});
      session.close();
    }
    for (const session of this.udpSessions.values()) {
      await session.request('closeUdp', {}, { timeoutMs: 3000 }).catch(() => {});
      session.close();
    }
    this.serialSessions.clear();
    this.ptySessions.clear();
    this.sshSessions.clear();
    this.mqttSessions.clear();
    this.udpSessions.clear();
  }

  get tools() {
    const link = this.link;
    const sessions = this.serialSessions;
    const ptySessions = this.ptySessions;
    const sshSessions = this.sshSessions;
    const mqttSessions = this.mqttSessions;
    const udpSessions = this.udpSessions;
    const gui = this.gui;
    const vision = this.vision;
    const shotDir = this.shotDir;

    const REGION = {
      type: 'object',
      description: 'Screen rectangle in physical pixels, origin at the top-left of the virtual desktop.',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
      },
      required: ['x', 'y', 'width', 'height'],
    };
    const AREA = {
      region: REGION,
      window: {
        type: 'string',
        description: 'Window title, title substring, process name or 0x-handle. Overrides region when set.',
      },
    };

    const getSession = (port) => {
      const session = sessions.get(port);
      if (!session) {
        throw new Error(`Serial port ${port} is not open. Call serial_open first.`);
      }
      return session;
    };

    const getFrom = (map, id, hint) => {
      const session = map.get(String(id));
      if (!session) throw new Error(`${hint} "${id}" is not open. Call the matching *_open / *_connect first.`);
      return session;
    };

    /** Open a transmit session, register it under `id`, and clean up on failure. */
    const openChannel = async (map, { id, protocol, sessionClass, build }) => {
      const socket = await link.openTransmit(protocol, { timeoutMs: 8000 });
      const session = new sessionClass({ id: String(id), socket, ...build });
      map.set(String(id), session);
      return session;
    };

    return [
      {
        name: 'info',
        title: 'Mind+ environment info',
        description:
          'Report the Mind+ 2.0 environment this server is bridged to: home directory, Mind+ link app root, ' +
          'data/Arduino paths, and the host network interfaces. Start here to confirm Mind+ is running and reachable.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        handler: async () => {
          const result = { host: link.host, controlPort: link.controlPort, transmitPort: link.transmitPort };
          try {
            result.pathInfo = await link.pathInfo();
          } catch (error) {
            result.pathInfoError = error.message;
          }
          try {
            result.homedir = await link.homedir();
          } catch (error) {
            result.homedirError = error.message;
          }
          try {
            result.networkInterfaces = await link.control('getNetworkInterfaces', {});
          } catch (error) {
            result.networkInterfacesError = error.message;
          }
          result.arduinoCli =
            result.pathInfo?.LINKAPPROOT != null
              ? `${result.pathInfo.LINKAPPROOT}\\tool\\arduino-cli.exe`
              : null;
          return ok(result);
        },
      },

      {
        name: 'serial_list_ports',
        title: 'List serial ports',
        description:
          'List the serial ports mind-link can see on this machine (path, manufacturer, friendlyName, pnpId). ' +
          'Use the returned "path" value with serial_open.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        handler: async () => ok({ ports: await link.serialList() }),
      },

      {
        name: 'serial_open',
        title: 'Open a serial session',
        description:
          'Open a persistent serial connection through mind-link and keep it alive for subsequent ' +
          'serial_read / serial_write / serial_close calls. The port is opened by mind-link (autoOpen), so this ' +
          'resolves once the "open" event arrives. Defaults: 9600 8N1.',
        inputSchema: {
          type: 'object',
          properties: {
            port: { type: 'string', description: 'Serial port path, e.g. "COM3" or "/dev/ttyUSB0".' },
            baudRate: { type: 'integer', description: 'Baud rate. Default 9600.' },
            dataBits: { type: 'integer', description: 'Data bits (5,6,7,8). Default 8.' },
            parity: { type: 'string', enum: ['none', 'even', 'odd', 'mark', 'space'], description: 'Default "none".' },
            stopBits: { type: 'integer', description: 'Stop bits (1, 1.5, 2). Default 1.' },
            openTimeoutMs: { type: 'integer', description: 'How long to wait for the port to open. Default 5000.' },
          },
          required: ['port'],
        },
        handler: async (args) => {
          const port = String(args.port);
          if (sessions.has(port)) {
            await sessions.get(port).close().catch(() => {});
            sessions.delete(port);
          }
          const config = {
            port,
            baudRate: args.baudRate ?? 9600,
            dataBits: args.dataBits ?? 8,
            parity: args.parity ?? 'none',
            stopBits: args.stopBits ?? 1,
          };
          const socket = await link.openTransmit('Serialport', { timeoutMs: 8000 });
          const session = new SerialSession({ port, socket, config });
          sessions.set(port, session);
          try {
            // params must be non-empty; an empty object is enough for mind-link.
            await socket.request('newSerialport', config, { timeoutMs: 8000 });
            await session.waitForOpen(args.openTimeoutMs ?? 5000);
          } catch (error) {
            sessions.delete(port);
            await session.close().catch(() => {});
            return fail(error.message);
          }
          return ok({ opened: true, ...session.status() });
        },
      },

      {
        name: 'serial_read',
        title: 'Read buffered serial data',
        description:
          'Drain bytes received on an open serial session. Waits up to timeoutMs for the first byte, then returns ' +
          'everything buffered. Returns the payload both as base64 (lossless) and as UTF-8 text (best effort).',
        inputSchema: {
          type: 'object',
          properties: {
            port: { type: 'string', description: 'The port opened with serial_open.' },
            timeoutMs: { type: 'integer', description: 'Max wait for data. Default 1000.' },
            maxBytes: { type: 'integer', description: 'Return at most this many bytes, leaving the rest buffered.' },
          },
          required: ['port'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const session = getSession(String(args.port));
          const chunk = await session.read({
            timeoutMs: args.timeoutMs ?? 1000,
            maxBytes: args.maxBytes,
          });
          return ok({ ...chunk, bufferedRemaining: session.byteCount, session: session.status() });
        },
      },

      {
        name: 'serial_write',
        title: 'Write to a serial session',
        description: 'Send bytes to an open serial session. Use encoding "base64" for binary payloads.',
        inputSchema: {
          type: 'object',
          properties: {
            port: { type: 'string', description: 'The port opened with serial_open.' },
            data: { type: 'string', description: 'Payload to send.' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How to interpret data. Default "utf8".' },
          },
          required: ['port', 'data'],
        },
        handler: async (args) => {
          const session = getSession(String(args.port));
          const bytes = await session.write(String(args.data), args.encoding ?? 'utf8');
          return ok({ wrote: bytes, port: session.port });
        },
      },

      {
        name: 'serial_status',
        title: 'Serial session status',
        description: 'Report the state of every serial session this server currently holds.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        handler: async () =>
          ok({ sessions: [...sessions.values()].map((session) => session.status()) }),
      },

      {
        name: 'serial_close',
        title: 'Close a serial session',
        description: 'Close an open serial session and release the port.',
        inputSchema: {
          type: 'object',
          properties: {
            port: { type: 'string', description: 'The port to close.' },
          },
          required: ['port'],
        },
        handler: async (args) => {
          const port = String(args.port);
          const session = sessions.get(port);
          if (!session) return ok({ closed: false, reason: `No open session for ${port}` });
          await session.close().catch(() => {});
          sessions.delete(port);
          return ok({ closed: true, port });
        },
      },

      {
        name: 'run_command',
        title: 'Run a local command via Mind+',
        description:
          'Run a command on this machine through Mind+\'s mind-link child_process channel and return its stdout, ' +
          'stderr and exit code. Useful for arduino-cli, python and other toolchain calls that Mind+ would run itself.',
        inputSchema: {
          type: 'object',
          properties: {
            cmd: { type: 'string', description: 'Executable to run, e.g. "python" or an absolute .exe path.' },
            args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
            cwd: { type: 'string', description: 'Working directory. Defaults to the mind-link process cwd.' },
            env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables merged over the inherited ones.' },
            timeoutMs: { type: 'integer', description: 'Kill the process after this many ms. Default 60000.' },
          },
          required: ['cmd'],
        },
        handler: async (args) => {
          const result = await link.runCommand({
            cmd: String(args.cmd),
            args: (args.args ?? []).map(String),
            cwd: args.cwd,
            env: args.env,
            timeoutMs: args.timeoutMs ?? 60000,
          });
          return ok(result);
        },
      },

      {
        name: 'arduino_cli',
        title: 'Run the bundled arduino-cli',
        description:
          'Invoke the arduino-cli.exe that ships inside the Mind+ install ' +
          '(<Mind+ Link root>/tool/arduino-cli.exe). Mind+ drives arduino-cli through its own config file, ' +
          '<user data>/Arduino/arduino-cli.yaml, which pins directories.data, directories.downloads and ' +
          'directories.user under Mind+\'s Arduino folder; this tool injects --config-file the same way, so ' +
          'boards, cores and libraries match what Mind+ installed. Pass arduino-cli arguments, e.g. ' +
          '["board","list"] or ["compile","--fqbn","arduino:avr:uno","sketch.ino"].',
        inputSchema: {
          type: 'object',
          properties: {
            args: { type: 'array', items: { type: 'string' }, description: 'arduino-cli arguments.' },
            cwd: { type: 'string', description: 'Working directory for the invocation.' },
            dataDir: {
              type: 'string',
              description:
                'Override Mind+\'s Arduino data directory (the folder that holds arduino-cli.yaml). ' +
                'Defaults to %HOMEDIR%\\AppData\\Local\\mind+\\Arduino on Windows, Library/mind+/Arduino on macOS, ' +
                '.mind+/Arduino on Linux.',
            },
            timeoutMs: { type: 'integer', description: 'Kill after this many ms. Default 300000 (5 min).' },
          },
          required: ['args'],
        },
        handler: async (args) => {
          const info = await link.pathInfo().catch(() => null);
          const root = info?.LINKAPPROOT;
          if (!root) return fail('Could not resolve the Mind+ Link app root from getPathInfo().');
          const home = (await link.homedir().catch(() => null)) ?? info?.HOMEDIR ?? null;

          const arduinoDir = args.dataDir ?? (home ? path.join(mindPlusDataDir(home), 'Arduino') : null);
          const configFile = arduinoDir ? path.join(arduinoDir, 'arduino-cli.yaml') : null;
          const userArgs = (args.args ?? []).map(String);

          // Reuse Mind+'s own arduino-cli.yaml rather than ARDUINO_DIRECTORIES_DATA:
          // the env var only fixes directories.data and would leave directories.user
          // (installed libraries) pointing at ~/Documents/Arduino.
          const prefix = [];
          let configNote = 'not applied';
          if (userArgs.some((arg) => arg === '--config-file' || arg.startsWith('--config-file='))) {
            configNote = 'supplied by caller';
          } else if (configFile) {
            const present = await link.control('exists', { path: configFile }).catch(() => null);
            if (present) {
              prefix.push('--config-file', configFile);
              configNote = configFile;
            } else {
              configNote = `no config file at ${configFile}`;
            }
          }

          const result = await link.runCommand({
            cmd: path.join(root, 'tool', 'arduino-cli.exe'),
            args: [...prefix, ...userArgs],
            cwd: args.cwd,
            timeoutMs: args.timeoutMs ?? 300000,
          });
          return ok({ ...result, arduinoDir: arduinoDir ?? null, configFile: configNote });
        },
      },

      {
        name: 'fs_read_text',
        title: 'Read a text file through Mind+',
        description:
          'Read a file using Mind+\'s own filesystem channel. Paths may use %HOMEDIR% and %APPROOT% (Mind+ Link root).',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, e.g. "%HOMEDIR%\\Desktop\\main.py".' },
            encoding: { type: 'string', description: 'Encoding passed to mind-link. Default "utf8".' },
          },
          required: ['path'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) =>
          ok({ path: args.path, content: await link.control('readFile', { path: String(args.path), encoding: args.encoding ?? 'utf8' }) }),
      },

      {
        name: 'fs_write_text',
        title: 'Write a text file through Mind+',
        description: 'Write text to a file using Mind+\'s filesystem channel.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Target file path (%HOMEDIR% / %APPROOT% allowed).' },
            content: { type: 'string', description: 'Text to write.' },
            flag: { type: 'string', description: 'fs write flag, e.g. "w" (default) or "a" to append.' },
          },
          required: ['path', 'content'],
        },
        handler: async (args) =>
          ok({
            path: args.path,
            result: await link.control('writeFile', {
              fileName: String(args.path),
              content: String(args.content),
              flag: args.flag ?? 'w',
            }),
          }),
      },

      {
        name: 'fs_list_dir',
        title: 'List a directory through Mind+',
        description: 'List directory entries using Mind+\'s filesystem channel.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (%HOMEDIR% / %APPROOT% allowed).' },
          },
          required: ['path'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) =>
          ok({ path: args.path, entries: await link.control('readdir', { path: String(args.path) }) }),
      },

      {
        name: 'fs_stat',
        title: 'Stat a path through Mind+',
        description: 'Return stat information for a path, using Mind+\'s filesystem channel.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Path to stat.' } },
          required: ['path'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => ok({ path: args.path, stat: await link.control('stat', { path: String(args.path) }) }),
      },

      {
        name: 'fs_mkdir',
        title: 'Create a directory through Mind+',
        description: 'Create a directory (recursively by default).',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory to create.' },
            recursive: { type: 'boolean', description: 'Create parents. Default true.' },
          },
          required: ['path'],
        },
        handler: async (args) =>
          ok({
            path: args.path,
            result: await link.control('mkdir', {
              path: String(args.path),
              options: { recursive: args.recursive ?? true },
            }),
          }),
      },

      {
        name: 'fs_remove',
        title: 'Delete a file or directory through Mind+',
        description: 'Delete a file (unlink) or a directory (rmdir). This is destructive.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to delete.' },
            directory: { type: 'boolean', description: 'Treat path as a directory. Default false.' },
            recursive: { type: 'boolean', description: 'For directories, remove recursively. Default false.' },
          },
          required: ['path'],
        },
        annotations: { destructiveHint: true },
        handler: async (args) => {
          if (args.directory) {
            return ok({
              path: args.path,
              result: await link.control('rmdir', {
                path: String(args.path),
                options: { recursive: args.recursive ?? false },
              }),
            });
          }
          return ok({ path: args.path, result: await link.control('unlink', { path: String(args.path) }) });
        },
      },

      {
        name: 'fs_rename',
        title: 'Rename or move a path through Mind+',
        description: 'Rename/move a file or directory using Mind+\'s filesystem channel.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Existing path.' },
            to: { type: 'string', description: 'New path.' },
          },
          required: ['from', 'to'],
        },
        handler: async (args) =>
          ok({
            from: args.from,
            to: args.to,
            result: await link.control('rename', { oldPath: String(args.from), newPath: String(args.to) }),
          }),
      },

      {
        name: 'download_file',
        title: 'Download a file through Mind+',
        description:
          'Download an HTTP(S) URL to a local path using mind-link\'s downloader (progress arrives as notifications). ' +
          'This is the same path Mind+ uses to fetch boards, cores and extensions.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Source URL.' },
            targetPath: { type: 'string', description: 'Destination file path.' },
            timeoutMs: { type: 'integer', description: 'Abort after this many ms. Default 300000.' },
          },
          required: ['url', 'targetPath'],
        },
        handler: async (args) =>
          ok({
            url: args.url,
            targetPath: args.targetPath,
            result: await link.control(
              'downloadFile',
              { url: String(args.url), targetPath: String(args.targetPath) },
              { timeoutMs: args.timeoutMs ?? 300000 },
            ),
          }),
      },

      {
        name: 'unzip',
        title: 'Extract an archive through Mind+',
        description: 'Extract a zip archive with mind-link\'s unzip (used by Mind+ for extension and toolchain archives).',
        inputSchema: {
          type: 'object',
          properties: {
            zipFile: { type: 'string', description: 'Archive to extract.' },
            unzipPath: { type: 'string', description: 'Destination directory.' },
          },
          required: ['zipFile', 'unzipPath'],
        },
        handler: async (args) =>
          ok({
            zipFile: args.zipFile,
            unzipPath: args.unzipPath,
            result: await link.control('unzip', { zipFile: String(args.zipFile), unzipPath: String(args.unzipPath) }),
          }),
      },

      // -------------------------------------------------------------------
      // node-pty — interactive terminals (subprotocol "node-pty")
      // -------------------------------------------------------------------

      {
        name: 'pty_open',
        title: 'Open a pseudo-terminal session',
        description:
          'Spawn a program inside a pseudo-terminal through mind-link\'s node-pty channel and keep the session alive ' +
          'for pty_read / pty_write / pty_resize / pty_kill. Unlike run_command this gives you an interactive TTY, so ' +
          'it is the right tool for REPLs, prompts and anything that behaves differently without a terminal. The ' +
          'spawn reply is immediate; output arrives asynchronously, so follow up with pty_read.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id used by later calls. Defaults to the command name.' },
            cmd: { type: 'string', description: 'Executable to run, e.g. "cmd.exe", "powershell.exe" or "python".' },
            args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
            cwd: { type: 'string', description: 'Working directory. mind-link defaults to %HOME%.' },
            env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables.' },
            cols: { type: 'integer', description: 'Initial terminal columns. Default 80.' },
            rows: { type: 'integer', description: 'Initial terminal rows. Default 24.' },
            name: { type: 'string', description: 'Terminal name. Default "xterm-color".' },
            useConpty: { type: 'boolean', description: 'Windows only: use ConPTY instead of winpty. Default false.' },
          },
          required: ['cmd'],
        },
        handler: async (args) => {
          const id = String(args.id ?? args.cmd);
          if (ptySessions.has(id)) {
            const previous = ptySessions.get(id);
            await previous.request('kill', {}, { timeoutMs: 3000 }).catch(() => {});
            previous.close();
            ptySessions.delete(id);
          }
          const options = {
            name: args.name ?? 'xterm-color',
            cols: args.cols ?? 80,
            rows: args.rows ?? 24,
            useConpty: args.useConpty ?? false,
          };
          if (args.cwd) options.cwd = args.cwd;
          if (args.env) options.env = args.env;

          const session = await openChannel(ptySessions, {
            id,
            protocol: 'node-pty',
            sessionClass: PtySession,
            build: { config: { cmd: args.cmd, args: args.args ?? [], options } },
          });
          try {
            await session.request(
              'spawn',
              { cmd: String(args.cmd), args: (args.args ?? []).map(String), options },
              { timeoutMs: 8000 },
            );
          } catch (error) {
            ptySessions.delete(id);
            session.close();
            return fail(error.message);
          }
          return ok({ opened: true, ...session.status() });
        },
      },

      {
        name: 'pty_write',
        title: 'Write to a pty session',
        description: 'Send input to an open pty session. Include a newline to submit a line.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from pty_open.' },
            data: { type: 'string', description: 'Text to send.' },
          },
          required: ['id', 'data'],
        },
        handler: async (args) => {
          const session = getFrom(ptySessions, args.id, 'pty session');
          const wrote = await session.write(String(args.data));
          return ok({ wrote, id: session.id });
        },
      },

      {
        name: 'pty_read',
        title: 'Read pty output',
        description:
          'Drain output produced by an open pty session. Waits up to timeoutMs for the first chunk, then returns ' +
          'everything buffered. Reports the exit status once the child has terminated.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from pty_open.' },
            timeoutMs: { type: 'integer', description: 'Max wait for output. Default 1000.' },
          },
          required: ['id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const session = getFrom(ptySessions, args.id, 'pty session');
          const chunks = await session.read({ timeoutMs: args.timeoutMs ?? 1000 });
          return ok({
            id: session.id,
            text: chunks.filter((chunk) => chunk.type === 'data').map((chunk) => chunk.data).join(''),
            exited: session.exited,
            exitInfo: session.exitInfo,
            session: session.status(),
          });
        },
      },

      {
        name: 'pty_resize',
        title: 'Resize a pty session',
        description: 'Resize the pseudo-terminal of an open pty session.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from pty_open.' },
            cols: { type: 'integer', description: 'Columns.' },
            rows: { type: 'integer', description: 'Rows.' },
          },
          required: ['id', 'cols', 'rows'],
        },
        handler: async (args) => {
          const session = getFrom(ptySessions, args.id, 'pty session');
          await session.request('resize', { cols: Number(args.cols), rows: Number(args.rows) }, { timeoutMs: 8000 });
          return ok({ resized: true, id: session.id, cols: Number(args.cols), rows: Number(args.rows) });
        },
      },

      {
        name: 'pty_pause',
        title: 'Pause pty output',
        description: 'Pause the data stream of an open pty session (node-pty flow control).',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session id from pty_open.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const session = getFrom(ptySessions, args.id, 'pty session');
          await session.request('pause', {}, { timeoutMs: 8000 });
          return ok({ paused: true, id: session.id });
        },
      },

      {
        name: 'pty_resume',
        title: 'Resume pty output',
        description: 'Resume the data stream of a paused pty session.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session id from pty_open.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const session = getFrom(ptySessions, args.id, 'pty session');
          await session.request('resume', {}, { timeoutMs: 8000 });
          return ok({ resumed: true, id: session.id });
        },
      },

      {
        name: 'pty_kill',
        title: 'Kill a pty session',
        description: 'Terminate the process behind an open pty session and drop the session.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session id from pty_open.' } },
          required: ['id'],
        },
        annotations: { destructiveHint: true },
        handler: async (args) => {
          const id = String(args.id);
          const session = ptySessions.get(id);
          if (!session) return ok({ killed: false, reason: `No open pty session "${id}"` });
          await session.request('kill', {}, { timeoutMs: 5000 }).catch(() => {});
          session.close();
          ptySessions.delete(id);
          return ok({ killed: true, id });
        },
      },

      // -------------------------------------------------------------------
      // ssh — subprotocol "ssh" (ssh2). Useful for a UNIHIKER board.
      // -------------------------------------------------------------------

      {
        name: 'ssh_connect',
        title: 'Open an SSH session',
        description:
          'Connect to a host over SSH through mind-link\'s ssh channel and keep the connection alive for ssh_exec, ' +
          'ssh_shell_* and ssh_sftp. Resolves once ssh2 reports "ready". Authentication uses whatever ssh2 accepts ' +
          '(password, privateKey, agent, ...). "username" is required: ssh2 validates its config synchronously and ' +
          'mind-link silently drops the call when that validation throws. NOTE: mind-link also drops the text of ssh ' +
          'errors (a typo in its reportError), so a refused connection is reported without the underlying reason.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id. Defaults to "user@host:port".' },
            host: { type: 'string', description: 'Hostname or IP address.' },
            port: { type: 'integer', description: 'SSH port. Default 22.' },
            username: { type: 'string', description: 'Login user. Required by ssh2.' },
            password: { type: 'string', description: 'Password authentication.' },
            privateKey: { type: 'string', description: 'PEM private key contents.' },
            passphrase: { type: 'string', description: 'Passphrase for privateKey.' },
            readyTimeout: { type: 'integer', description: 'ssh2 handshake timeout in ms.' },
            timeoutMs: { type: 'integer', description: 'How long to wait for "ready". Default 10000.' },
          },
          required: ['host', 'username'],
        },
        handler: async (args) => {
          if (args.username === undefined || args.username === null || args.username === '') {
            return fail(
              'ssh_connect requires "username". ssh2 validates its config synchronously, and mind-link drops the ' +
                'call without replying when that validation throws.',
            );
          }
          const config = { port: 22, ...args };
          delete config.id;
          delete config.timeoutMs;
          config.host = String(args.host);
          config.username = String(args.username);
          const id = String(args.id ?? `${config.username}@${config.host}:${config.port}`);

          if (sshSessions.has(id)) {
            const previous = sshSessions.get(id);
            await previous.request('end', {}, { timeoutMs: 3000 }).catch(() => {});
            previous.close();
            sshSessions.delete(id);
          }

          const session = await openChannel(sshSessions, {
            id,
            protocol: 'ssh',
            sessionClass: SshSession,
            build: { config },
          });
          try {
            await session.request('connect', config, { timeoutMs: 8000 });
          } catch (error) {
            sshSessions.delete(id);
            session.close();
            return fail(
              /timed out/.test(error.message)
                ? `mind-link never answered the ssh "connect" call (${error.message}). ssh2 validates its config ` +
                    'synchronously; a missing or malformed field makes mind-link drop the call silently.'
                : error.message,
            );
          }

          const waitMs = args.timeoutMs ?? 10000;
          await session.queue.waitFor(() => session.ready || session.lastError !== null || session.closed, waitMs);
          if (session.ready) return ok({ connected: true, ...session.status() });
          const reason = session.lastError
            ? 'the connection was refused or the handshake failed (mind-link reports ssh errors without their message)'
            : session.closed
              ? 'mind-link closed the connection'
              : `timed out after ${waitMs}ms`;
          sshSessions.delete(id);
          session.close();
          return fail(`ssh_connect to ${config.host}:${config.port} failed: ${reason}`);
        },
      },

      {
        name: 'ssh_exec',
        title: 'Run a command over SSH',
        description:
          'Run a command on the SSH host (ssh2 exec with a pty) and collect its stdout, stderr and exit code. ' +
          'Blocks until the remote command exits or timeoutMs elapses, then signals the process.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from ssh_connect.' },
            cmd: { type: 'string', description: 'Shell command to run on the remote host.' },
            timeoutMs: { type: 'integer', description: 'Abort after this many ms. Default 60000.' },
          },
          required: ['id', 'cmd'],
        },
        handler: async (args) => {
          const session = getFrom(sshSessions, args.id, 'ssh session');
          const result = await session.exec({ cmd: String(args.cmd), timeoutMs: args.timeoutMs ?? 60000 });
          return ok({ id: session.id, ...result });
        },
      },

      {
        name: 'ssh_shell_open',
        title: 'Open an SSH shell stream',
        description: 'Start an interactive shell on the SSH host. Output is buffered for ssh_shell_read.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session id from ssh_connect.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const session = getFrom(sshSessions, args.id, 'ssh session');
          await session.ensureShell();
          return ok({ shellOpen: true, id: session.id });
        },
      },

      {
        name: 'ssh_shell_write',
        title: 'Write to an SSH shell stream',
        description: 'Send input to the interactive shell opened with ssh_shell_open.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from ssh_connect.' },
            data: { type: 'string', description: 'Text to send.' },
          },
          required: ['id', 'data'],
        },
        handler: async (args) => {
          const session = getFrom(sshSessions, args.id, 'ssh session');
          await session.request('shellWrite', String(args.data), { timeoutMs: 8000 });
          return ok({ wrote: String(args.data).length, id: session.id });
        },
      },

      {
        name: 'ssh_shell_read',
        title: 'Read SSH shell output',
        description: 'Drain the output buffered from the interactive shell. Waits up to timeoutMs for the first chunk.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from ssh_connect.' },
            timeoutMs: { type: 'integer', description: 'Max wait for output. Default 1000.' },
          },
          required: ['id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const session = getFrom(sshSessions, args.id, 'ssh session');
          const chunks = await session.read({ timeoutMs: args.timeoutMs ?? 1000 });
          return ok({
            id: session.id,
            text: chunks.filter((chunk) => chunk.type === 'shell').map((chunk) => chunk.text).join(''),
            chunks,
            shellOpen: session.shellOpen,
          });
        },
      },

      {
        name: 'ssh_sftp',
        title: 'SFTP operations over SSH',
        description:
          'Run one SFTP operation against the SSH host. Ops: readdir, mkdir (recursive), rmdir (recursive), stat, ' +
          'unlink, rename, readfile, writefile. The SFTP subsystem is opened lazily on first use.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from ssh_connect.' },
            op: {
              type: 'string',
              enum: ['readdir', 'mkdir', 'rmdir', 'stat', 'unlink', 'rename', 'readfile', 'writefile'],
              description: 'Operation to perform.',
            },
            path: { type: 'string', description: 'Target path (not used by rename).' },
            from: { type: 'string', description: 'rename: existing path.' },
            to: { type: 'string', description: 'rename: new path.' },
            data: { type: 'string', description: 'writefile: contents.' },
            encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'writefile: how to read `data`. Default utf8.' },
            flag: { type: 'string', description: 'writefile: fs flag. Default "w".' },
          },
          required: ['id', 'op'],
        },
        handler: async (args) => {
          const session = getFrom(sshSessions, args.id, 'ssh session');
          await session.ensureSftp();
          const op = String(args.op);
          const remote = args.path !== undefined ? String(args.path) : undefined;

          switch (op) {
            case 'readdir':
              return ok({ op, path: remote, entries: await session.request('readdir', { path: remote }, { timeoutMs: 30000 }) });
            case 'mkdir':
              return ok({ op, path: remote, result: await session.request('mkdir', { path: remote }, { timeoutMs: 30000 }) });
            case 'rmdir':
              return ok({ op, path: remote, result: await session.request('rmdir', { path: remote }, { timeoutMs: 60000 }) });
            case 'stat':
              return ok({ op, path: remote, stat: await session.request('stat', { path: remote }, { timeoutMs: 30000 }) });
            case 'unlink':
              return ok({ op, path: remote, result: await session.request('unlink', { path: remote }, { timeoutMs: 30000 }) });
            case 'rename':
              return ok({
                op,
                from: args.from,
                to: args.to,
                result: await session.request(
                  'rename',
                  { oldPath: String(args.from), newPath: String(args.to) },
                  { timeoutMs: 30000 },
                ),
              });
            case 'readfile': {
              const raw = await session.request('readfile', { path: remote }, { timeoutMs: 60000 });
              const buffer = Buffer.from(Array.isArray(raw) ? raw : []);
              return ok({
                op,
                path: remote,
                bytes: buffer.length,
                base64: buffer.toString('base64'),
                text: buffer.toString('utf8'),
              });
            }
            case 'writefile': {
              const payload =
                args.encoding === 'base64'
                  ? Array.from(Buffer.from(String(args.data ?? ''), 'base64'))
                  : String(args.data ?? '');
              return ok({
                op,
                path: remote,
                result: await session.request(
                  'writefile',
                  { path: remote, data: payload, flag: args.flag ?? 'w' },
                  { timeoutMs: 60000 },
                ),
              });
            }
            default:
              return fail(`Unknown sftp op "${op}"`);
          }
        },
      },

      {
        name: 'ssh_disconnect',
        title: 'Close an SSH session',
        description: 'End the SSH connection and drop the session (this also closes any shell or SFTP subsystem).',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session id from ssh_connect.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const id = String(args.id);
          const session = sshSessions.get(id);
          if (!session) return ok({ disconnected: false, reason: `No open ssh session "${id}"` });
          await session.request('end', {}, { timeoutMs: 5000 }).catch(() => {});
          session.close();
          sshSessions.delete(id);
          return ok({ disconnected: true, id });
        },
      },

      // -------------------------------------------------------------------
      // MQTT — subprotocol "MQTT"
      // -------------------------------------------------------------------

      {
        name: 'mqtt_connect',
        title: 'Connect to an MQTT broker',
        description:
          'Connect to an MQTT broker through mind-link\'s MQTT channel and keep the connection alive for ' +
          'mqtt_subscribe / mqtt_publish / mqtt_read. Resolves once the broker confirms the connection, or reports ' +
          'the broker error (mind-link ends the client after an error, so this will not hang).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id. Defaults to the broker URL.' },
            url: { type: 'string', description: 'Broker URL, e.g. "mqtt://broker.emqx.io:1883" or "mqtts://...".' },
            options: { type: 'object', description: 'mqtt.js connect options (clientId, username, password, keepalive, ...).' },
            timeoutMs: { type: 'integer', description: 'How long to wait for the connection. Default 10000.' },
          },
          required: ['url'],
        },
        handler: async (args) => {
          const url = String(args.url);
          const id = String(args.id ?? url);
          if (mqttSessions.has(id)) {
            const previous = mqttSessions.get(id);
            await previous.request('end', {}, { timeoutMs: 3000 }).catch(() => {});
            previous.close();
            mqttSessions.delete(id);
          }

          const session = await openChannel(mqttSessions, {
            id,
            protocol: 'MQTT',
            sessionClass: MqttSession,
            build: { url },
          });
          try {
            await session.request('connect', { url, options: args.options ?? {} }, { timeoutMs: 8000 });
          } catch (error) {
            mqttSessions.delete(id);
            session.close();
            return fail(error.message);
          }

          const waitMs = args.timeoutMs ?? 10000;
          await session.queue.waitFor(() => session.connected || session.lastError !== null || session.closed, waitMs);
          if (session.connected) return ok({ connected: true, ...session.status() });
          const reason = session.lastError ?? (session.closed ? 'broker closed the connection' : `timed out after ${waitMs}ms`);
          mqttSessions.delete(id);
          session.close();
          return fail(`mqtt_connect to ${url} failed: ${reason}`);
        },
      },

      {
        name: 'mqtt_subscribe',
        title: 'Subscribe to MQTT topics',
        description: 'Subscribe an open MQTT session to a topic. Inbound messages are buffered for mqtt_read.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from mqtt_connect.' },
            topic: { type: 'string', description: 'Topic filter, e.g. "sensors/#".' },
            options: { type: 'object', description: 'mqtt.js subscribe options (qos, ...).' },
          },
          required: ['id', 'topic'],
        },
        handler: async (args) => {
          const session = getFrom(mqttSessions, args.id, 'mqtt session');
          await session.request('subscribe', { topic: String(args.topic), options: args.options ?? {} }, { timeoutMs: 15000 });
          return ok({ subscribed: true, id: session.id, topic: String(args.topic) });
        },
      },

      {
        name: 'mqtt_publish',
        title: 'Publish an MQTT message',
        description: 'Publish a message to a topic on an open MQTT session.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from mqtt_connect.' },
            topic: { type: 'string', description: 'Topic to publish to.' },
            message: { type: 'string', description: 'Payload.' },
            options: { type: 'object', description: 'mqtt.js publish options (qos, retain, ...).' },
          },
          required: ['id', 'topic', 'message'],
        },
        handler: async (args) => {
          const session = getFrom(mqttSessions, args.id, 'mqtt session');
          await session.request(
            'publish',
            { topic: String(args.topic), message: String(args.message), options: args.options ?? {} },
            { timeoutMs: 15000 },
          );
          return ok({ published: true, id: session.id, topic: String(args.topic) });
        },
      },

      {
        name: 'mqtt_read',
        title: 'Read buffered MQTT messages',
        description: 'Drain messages received on an open MQTT session. Waits up to timeoutMs for the first message.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from mqtt_connect.' },
            timeoutMs: { type: 'integer', description: 'Max wait for a message. Default 1000.' },
          },
          required: ['id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const session = getFrom(mqttSessions, args.id, 'mqtt session');
          const messages = await session.read({ timeoutMs: args.timeoutMs ?? 1000 });
          return ok({ id: session.id, messages, session: session.status() });
        },
      },

      {
        name: 'mqtt_disconnect',
        title: 'Disconnect from an MQTT broker',
        description: 'End the MQTT connection and drop the session.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session id from mqtt_connect.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const id = String(args.id);
          const session = mqttSessions.get(id);
          if (!session) return ok({ disconnected: false, reason: `No open mqtt session "${id}"` });
          await session.request('end', {}, { timeoutMs: 5000 }).catch(() => {});
          session.close();
          mqttSessions.delete(id);
          return ok({ disconnected: true, id });
        },
      },

      // -------------------------------------------------------------------
      // UDP — subprotocol "UDP"
      // -------------------------------------------------------------------

      {
        name: 'udp_open',
        title: 'Open a UDP socket',
        description:
          'Create a UDP socket through mind-link\'s UDP channel. Follow with udp_bind before receiving datagrams. ' +
          'A resolved udp_bind is what makes the socket ready — mind-link\'s "open" notification is wired to the ' +
          'socket\'s first inbound datagram rather than to bind.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id. Defaults to "udp4".' },
            type: { type: 'string', enum: ['udp4', 'udp6'], description: 'Address family. Default "udp4".' },
          },
        },
        handler: async (args) => {
          const type = String(args.type ?? 'udp4');
          const id = String(args.id ?? type);
          if (udpSessions.has(id)) {
            const previous = udpSessions.get(id);
            await previous.request('closeUdp', {}, { timeoutMs: 3000 }).catch(() => {});
            previous.close();
            udpSessions.delete(id);
          }
          const session = await openChannel(udpSessions, {
            id,
            protocol: 'UDP',
            sessionClass: UdpSession,
            build: { type },
          });
          try {
            await session.request('createSocket', type, { timeoutMs: 8000 });
          } catch (error) {
            udpSessions.delete(id);
            session.close();
            return fail(error.message);
          }
          return ok({ created: true, ...session.status() });
        },
      },

      {
        name: 'udp_bind',
        title: 'Bind a UDP socket',
        description: 'Bind an open UDP socket to a local port so it can receive datagrams.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from udp_open.' },
            port: { type: 'integer', description: 'Local port.' },
            ip: { type: 'string', description: 'Local address. Defaults to all interfaces.' },
          },
          required: ['id', 'port'],
        },
        handler: async (args) => {
          const session = getFrom(udpSessions, args.id, 'udp session');
          await session.request('bindPort', { port: Number(args.port), ip: args.ip }, { timeoutMs: 10000 });
          session.bound = { port: Number(args.port), ip: args.ip ?? null };
          return ok({ bound: true, ...session.status() });
        },
      },

      {
        name: 'udp_send',
        title: 'Send a UDP datagram',
        description:
          'Send a datagram from an open UDP socket. The payload must be text: mind-link forwards the value straight ' +
          'to dgram.send(), which accepts only a string (JSON cannot carry a Buffer), so binary payloads are not ' +
          'possible over this channel.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from udp_open.' },
            message: { type: 'string', description: 'Text payload.' },
            port: { type: 'integer', description: 'Destination port.' },
            address: { type: 'string', description: 'Destination address.' },
          },
          required: ['id', 'message', 'port', 'address'],
        },
        handler: async (args) => {
          const session = getFrom(udpSessions, args.id, 'udp session');
          const message = String(args.message);
          await session.request(
            'sendUdpMessage',
            {
              message,
              offset: 0,
              length: Buffer.byteLength(message),
              port: Number(args.port),
              address: String(args.address),
            },
            { timeoutMs: 10000 },
          );
          return ok({ sent: true, id: session.id, bytes: Buffer.byteLength(message) });
        },
      },

      {
        name: 'udp_set_broadcast',
        title: 'Enable UDP broadcast',
        description: 'Enable or disable SO_BROADCAST on an open UDP socket (needed for discovery broadcasts).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from udp_open.' },
            flag: { type: 'boolean', description: 'true to enable broadcast. Default true.' },
          },
          required: ['id'],
        },
        handler: async (args) => {
          const session = getFrom(udpSessions, args.id, 'udp session');
          const flag = args.flag ?? true;
          await session.request('setBroadcast', flag, { timeoutMs: 8000 });
          return ok({ broadcast: flag, id: session.id });
        },
      },

      {
        name: 'udp_read',
        title: 'Read UDP datagrams',
        description: 'Drain datagrams received on an open UDP socket. Waits up to timeoutMs for the first one.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Session id from udp_open.' },
            timeoutMs: { type: 'integer', description: 'Max wait for a datagram. Default 1000.' },
          },
          required: ['id'],
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          const session = getFrom(udpSessions, args.id, 'udp session');
          const messages = await session.read({ timeoutMs: args.timeoutMs ?? 1000 });
          return ok({ id: session.id, messages, session: session.status() });
        },
      },

      {
        name: 'udp_close',
        title: 'Close a UDP socket',
        description: 'Close an open UDP socket and drop the session.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Session id from udp_open.' } },
          required: ['id'],
        },
        handler: async (args) => {
          const id = String(args.id);
          const session = udpSessions.get(id);
          if (!session) return ok({ closed: false, reason: `No open udp session "${id}"` });
          await session.request('closeUdp', {}, { timeoutMs: 5000 }).catch(() => {});
          session.close();
          udpSessions.delete(id);
          return ok({ closed: true, id });
        },
      },

      // -------------------------------------------------------------------
      // GUI automation — screen capture, mouse, keyboard, windows
      //
      // These drive the local desktop through a PowerShell host, not through
      // mind-link, so they work even when Mind+ is closed.
      // -------------------------------------------------------------------

      {
        name: 'screen_info',
        title: 'Screen and input state',
        description:
          'Report the desktop layout: virtual desktop bounds, every monitor (bounds, work area, DPI and scale ' +
          'factor), current cursor position, the DPI awareness the capture host achieved, the folder screenshots ' +
          'are written to, and the vision provider in use. Start here before any GUI automation.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        handler: guard(async () => {
          const info = await gui.screenInfo();
          return ok({
            ...info,
            platform: process.platform,
            guiSupported: guiSupported(),
            hostPid: gui.info?.pid ?? null,
            shotDir,
            vision: describeVisionConfig(vision.config),
          });
        }),
      },

      {
        name: 'screen_capture',
        title: 'Screenshot to a PNG',
        description:
          'Capture the screen (or a region, or a single window) to a PNG file and return its path and size. ' +
          'Coordinates in the result are in physical pixels of the virtual desktop, which is also the coordinate ' +
          'space every mouse_* tool accepts. Set inline=true to also get the image back in the response.',
        inputSchema: {
          type: 'object',
          properties: {
            ...AREA,
            format: { type: 'string', enum: ['png', 'jpg'], description: 'Default png.' },
            quality: { type: 'integer', description: 'JPEG quality 1-100. Default 90.' },
            inline: { type: 'boolean', description: 'Also return the image bytes. Default false.' },
            printWindow: {
              type: 'boolean',
              description: 'For window captures, use PrintWindow so occluded windows still render. Default true.',
            },
          },
        },
        annotations: { readOnlyHint: true },
        handler: guard(async (args) => {
          const area = await resolveArea(gui, args);
          const capture = await gui.capture({
            x: area?.x,
            y: area?.y,
            width: area?.width,
            height: area?.height,
            handle: area?.handle,
            format: args.format ?? 'png',
            quality: args.quality ?? 90,
            printWindow: args.printWindow ?? true,
          });
          const payload = { ...capture, region: area ? { x: area.x, y: area.y, width: area.width, height: area.height } : null };
          if (!args.inline) return ok(payload);
          const mime = String(capture.path).toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
          return okImage(payload, fs.readFileSync(capture.path).toString('base64'), mime);
        }),
      },

      {
        name: 'screen_pixel',
        title: 'Colour of one pixel',
        description: 'Read the colour at a single screen coordinate. Useful to assert on UI state without a model.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'integer', description: 'Screen X in physical pixels.' },
            y: { type: 'integer', description: 'Screen Y in physical pixels.' },
          },
          required: ['x', 'y'],
        },
        annotations: { readOnlyHint: true },
        handler: guard(async (args) => ok(await gui.pixelColor(Number(args.x), Number(args.y)))),
      },

      {
        name: 'screen_wait_change',
        title: 'Wait for the screen to change',
        description:
          'Watch a region (or window, or the whole desktop) until it differs from the baseline by more than ' +
          '"tolerance" of its pixels, or until timeoutMs elapses. Handy right after an action that triggers a ' +
          'slow UI transition. Returns the changed bounding box when something moved.',
        inputSchema: {
          type: 'object',
          properties: {
            ...AREA,
            timeoutMs: { type: 'integer', description: 'Give up after this long. Default 10000.' },
            intervalMs: { type: 'integer', description: 'Poll interval. Default 300.' },
            tolerance: { type: 'number', description: 'Fraction of pixels that must differ to count as a change. Default 0.002.' },
            settleMs: { type: 'integer', description: 'Keep watching until the screen is stable for this long. Default 0.' },
          },
        },
        annotations: { readOnlyHint: true },
        handler: guard(async (args) => {
          const started = Date.now();
          const timeoutMs = args.timeoutMs ?? 10000;
          const intervalMs = Math.max(50, args.intervalMs ?? 300);
          const tolerance = args.tolerance ?? 0.002;
          const first = await grabScreen(gui, { region: args.region, window: args.window });
          let last = first;
          let changed = null;
          while (Date.now() - started < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            const next = await grabScreen(gui, { region: args.region, window: args.window });
            const delta = diffImages(last.full, next.full, {});
            last = next;
            if (delta.ratio >= tolerance) {
              changed = { ...delta, screenshot: next.file, elapsedMs: Date.now() - started };
              if (!args.settleMs) break;
            }
          }
          return ok({
            changed: Boolean(changed),
            elapsedMs: Date.now() - started,
            baseline: first.file,
            latest: last.file,
            detail: changed,
          });
        }),
      },

      // -------------------------------------------------------------------
      // Mouse
      // -------------------------------------------------------------------

      {
        name: 'mouse_move',
        title: 'Move the cursor',
        description: 'Move the mouse pointer to a screen coordinate, optionally gliding there over durationMs.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            durationMs: { type: 'integer', description: 'Glide time. 0 teleports. Default 0.' },
            dryRun: { type: 'boolean', description: 'Report the move without performing it.' },
          },
          required: ['x', 'y'],
        },
        handler: guard(async (args) =>
          ok(await gui.mouseMove(Number(args.x), Number(args.y), { durationMs: args.durationMs ?? 0, dryRun: Boolean(args.dryRun) })),
        ),
      },

      {
        name: 'mouse_click',
        title: 'Click the mouse',
        description:
          'Move to a screen coordinate and click. count=2 gives a double-click; holdMs keeps the button down ' +
          'long enough for drag-happy widgets to notice. Use dryRun to verify a plan without clicking.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
            count: { type: 'integer', description: 'Default 1.' },
            intervalMs: { type: 'integer', description: 'Gap between repeated clicks. Default 60.' },
            holdMs: { type: 'integer', description: 'Hold the button down this long. Default 0.' },
            dryRun: { type: 'boolean' },
          },
          required: ['x', 'y'],
        },
        handler: guard(async (args) =>
          ok(
            await gui.mouseClick(Number(args.x), Number(args.y), {
              button: args.button ?? 'left',
              count: args.count ?? 1,
              intervalMs: args.intervalMs ?? 60,
              holdMs: args.holdMs ?? 0,
              dryRun: Boolean(args.dryRun),
            }),
          ),
        ),
      },

      {
        name: 'mouse_drag',
        title: 'Drag the mouse',
        description:
          'Press at one point, glide to another and release. This is how you move windows, sliders, canvas ' +
          'objects and Mind+ blocks. durationMs controls how slowly the pointer travels, which many apps need.',
        inputSchema: {
          type: 'object',
          properties: {
            fromX: { type: 'integer' },
            fromY: { type: 'integer' },
            toX: { type: 'integer' },
            toY: { type: 'integer' },
            durationMs: { type: 'integer', description: 'Glide time for the drag. Default 300.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
            dryRun: { type: 'boolean' },
          },
          required: ['fromX', 'fromY', 'toX', 'toY'],
        },
        handler: guard(async (args) =>
          ok(
            await gui.mouseDrag(Number(args.fromX), Number(args.fromY), Number(args.toX), Number(args.toY), {
              durationMs: args.durationMs ?? 300,
              button: args.button ?? 'left',
              dryRun: Boolean(args.dryRun),
            }),
          ),
        ),
      },

      {
        name: 'mouse_scroll',
        title: 'Scroll the mouse wheel',
        description: 'Scroll at a screen coordinate. deltaV is in wheel notches, positive = up. deltaH scrolls sideways.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            deltaV: { type: 'integer', description: 'Vertical notches, positive scrolls up.' },
            deltaH: { type: 'integer', description: 'Horizontal notches, positive scrolls right.' },
            dryRun: { type: 'boolean' },
          },
          required: ['x', 'y'],
        },
        handler: guard(async (args) =>
          ok(
            await gui.mouseScroll(Number(args.x), Number(args.y), {
              deltaV: args.deltaV ?? 0,
              deltaH: args.deltaH ?? 0,
              dryRun: Boolean(args.dryRun),
            }),
          ),
        ),
      },

      {
        name: 'mouse_button',
        title: 'Hold or release a mouse button',
        description:
          'Press or release a mouse button without moving first (pass x/y to move). Use mouse_button down, then ' +
          'mouse_move, then mouse_button up for drags that need to pause mid-way.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'integer', description: 'Optional: move here before pressing.' },
            y: { type: 'integer' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
            down: { type: 'boolean', description: 'true = press, false = release.' },
            dryRun: { type: 'boolean' },
          },
          required: ['down'],
        },
        handler: guard(async (args) =>
          ok(
            await gui.mouseButton(args.x, args.y, {
              button: args.button ?? 'left',
              down: Boolean(args.down),
              dryRun: Boolean(args.dryRun),
            }),
          ),
        ),
      },

      // -------------------------------------------------------------------
      // Keyboard and clipboard
      // -------------------------------------------------------------------

      {
        name: 'keyboard_type',
        title: 'Type text',
        description:
          'Type a string into whatever has focus, using Unicode injection so non-ASCII text works. "\\n" presses ' +
          'Enter and "\\t" presses Tab. Nothing is typed when dryRun is set.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to type. \\n = Enter, \\t = Tab.' },
            delayMs: { type: 'integer', description: 'Delay between characters. Default 12.' },
            dryRun: { type: 'boolean' },
          },
          required: ['text'],
        },
        handler: guard(async (args) =>
          ok(await gui.keyType(String(args.text), { delayMs: args.delayMs ?? 12, dryRun: Boolean(args.dryRun) })),
        ),
      },

      {
        name: 'keyboard_press',
        title: 'Press a key combination',
        description:
          'Press and release a chord such as "ctrl+shift+s", "enter", "f5" or "alt+tab". Modifiers are held for ' +
          'the duration of the chord. Use vk:0x41 syntax for a raw virtual key code.',
        inputSchema: {
          type: 'object',
          properties: {
            keys: { type: 'string', description: 'e.g. ctrl+shift+s, enter, alt+tab, f5, pageup.' },
            dryRun: { type: 'boolean', description: 'Resolve the key codes without pressing them.' },
          },
          required: ['keys'],
        },
        handler: guard(async (args) => ok(await gui.keyPress(String(args.keys), { dryRun: Boolean(args.dryRun) }))),
      },

      {
        name: 'clipboard_read',
        title: 'Read the clipboard',
        description: 'Return the clipboard text. The quickest way to get text out of an app that will not let you copy programmatically.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        handler: guard(async () => {
          const { text: value } = await gui.clipboardGet();
          return ok({ text: value, length: value.length });
        }),
      },

      {
        name: 'clipboard_write',
        title: 'Write the clipboard',
        description: 'Replace the clipboard contents with the given text.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        handler: guard(async (args) => ok(await gui.clipboardSet(String(args.text)))),
      },

      // -------------------------------------------------------------------
      // Windows
      // -------------------------------------------------------------------

      {
        name: 'window_list',
        title: 'List windows',
        description:
          'Enumerate top-level windows with their title, process, class and screen rectangle. By default only ' +
          'visible, titled, non-owned, non-cloaked windows are returned — which is what you want for targeting.',
        inputSchema: {
          type: 'object',
          properties: {
            visibleOnly: { type: 'boolean', description: 'Default true.' },
            titledOnly: { type: 'boolean', description: 'Default true.' },
            includeCloaked: { type: 'boolean', description: 'Include windows DWM has cloaked (UWP background). Default false.' },
            includeOwned: { type: 'boolean', description: 'Include owned dialogs and tool windows. Default false.' },
            filter: { type: 'string', description: 'Only return windows whose title or process contains this text.' },
          },
        },
        annotations: { readOnlyHint: true },
        handler: guard(async (args) => {
          const { windows } = await gui.windowList({
            visibleOnly: args.visibleOnly ?? true,
            titledOnly: args.titledOnly ?? true,
            includeCloaked: Boolean(args.includeCloaked),
            includeOwned: Boolean(args.includeOwned),
          });
          const needle = args.filter ? String(args.filter).toLowerCase() : null;
          const filtered = needle
            ? windows.filter(
                (w) => w.title.toLowerCase().includes(needle) || (w.process ?? '').toLowerCase().includes(needle),
              )
            : windows;
          return ok({ count: filtered.length, windows: filtered });
        }),
      },

      {
        name: 'window_rect',
        title: 'Rectangle of one window',
        description: 'Look up a single window by title, title substring, process name or 0x-handle and return its bounds.',
        inputSchema: {
          type: 'object',
          properties: { window: { type: 'string', description: 'Title, substring, process name or 0x-handle.' } },
          required: ['window'],
        },
        annotations: { readOnlyHint: true },
        handler: guard(async (args) => {
          const found = await gui.findWindow(String(args.window));
          if (!found) return fail(`no visible window matches "${args.window}"`);
          return ok(await gui.windowRect(found.handle));
        }),
      },

      {
        name: 'window_activate',
        title: 'Bring a window to the front',
        description:
          'Restore (if minimised) and focus a window so subsequent keyboard input lands in it. Returns whether ' +
          'the window actually became the foreground window — Windows sometimes refuses.',
        inputSchema: {
          type: 'object',
          properties: {
            window: { type: 'string', description: 'Title, substring, process name or 0x-handle.' },
            waitMs: { type: 'integer', description: 'Settle time after focusing. Default 150.' },
          },
          required: ['window'],
        },
        handler: guard(async (args) => {
          const found = await gui.findWindow(String(args.window));
          if (!found) return fail(`no visible window matches "${args.window}"`);
          return ok(await gui.windowActivate(found.handle, { waitMs: args.waitMs ?? 150 }));
        }),
      },

      // -------------------------------------------------------------------
      // Recognition — local (no model required)
      // -------------------------------------------------------------------

      {
        name: 'image_find',
        title: 'Find an image on screen',
        description:
          'Template-match a PNG against a fresh screenshot and return the best match plus its alternatives. ' +
          'This is the precise, offline half of the recognition framework: cut a template once with image_crop ' +
          'and reuse it forever. Scores are 0..1; 0.98+ means a near-exact match.',
        inputSchema: {
          type: 'object',
          properties: {
            template: { type: 'string', description: 'Path to the template PNG.' },
            ...AREA,
            source: { type: 'string', description: 'Search a saved PNG instead of taking a fresh screenshot.' },
            sourceOrigin: {
              type: 'object',
              description: 'Screen coordinate that the source PNG\'s top-left corner came from, so results can be mapped back.',
              properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            },
            searchRegion: {
              type: 'object',
              description: 'Restrict the search to this rectangle of the searched image (image coordinates, not screen).',
              properties: {
                x: { type: 'integer' },
                y: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
            },
            minScore: { type: 'number', description: 'Minimum similarity to accept. Default 0.9.' },
            stride: { type: 'integer', description: 'Search step in pixels. Default: 2 for templates >= 24px, else 1.' },
            maxWidth: { type: 'integer', description: 'Downscale the screenshot before searching (speeds up large screens).' },
            maxResults: { type: 'integer', description: 'How many distinct matches to return. Default 5.' },
            click: { type: 'boolean', description: 'Click the best match. Default false.' },
            dryRun: { type: 'boolean', description: 'Plan the click without performing it.' },
          },
          required: ['template'],
        },
        handler: guard(async (args) => {
          const result = await findImageOnScreen({
            gui,
            templatePath: String(args.template),
            source: args.source,
            sourceOrigin: args.sourceOrigin,
            region: args.region,
            window: args.window,
            searchRegion: args.searchRegion,
            minScore: args.minScore,
            stride: args.stride,
            maxWidth: args.maxWidth,
            maxResults: args.maxResults ?? 5,
          });
          if (!result.found || !args.click) return ok(result);
          const clicked = await gui.mouseClick(result.screenPoint.x, result.screenPoint.y, {
            button: 'left',
            count: 1,
            dryRun: Boolean(args.dryRun),
          });
          return ok({ ...result, clicked });
        }),
      },

      {
        name: 'pixel_find',
        title: 'Find a colour on screen',
        description:
          'Locate pixels matching a colour (with per-channel tolerance) and return the bounding box, centroid and ' +
          'match count. Good for indicator lights, LED states and solid-colour UI regions.',
        inputSchema: {
          type: 'object',
          properties: {
            color: { type: 'string', description: 'Hex colour such as #ff8800.' },
            tolerance: { type: 'integer', description: 'Per-channel tolerance 0-255. Default 16.' },
            ...AREA,
            source: { type: 'string', description: 'Search a saved PNG instead of taking a fresh screenshot.' },
            sourceOrigin: {
              type: 'object',
              description: 'Screen coordinate that the source PNG\'s top-left corner came from.',
              properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            },
            click: { type: 'boolean', description: 'Click the centroid of the matches. Default false.' },
            dryRun: { type: 'boolean' },
          },
          required: ['color'],
        },
        handler: guard(async (args) => {
          const result = await findColorOnScreen({
            gui,
            color: parseColor(String(args.color)),
            tolerance: args.tolerance ?? 16,
            source: args.source,
            sourceOrigin: args.sourceOrigin,
            region: args.region,
            window: args.window,
          });
          if (!result.found || !args.click) return ok(result);
          const clicked = await gui.mouseClick(result.screenPoint.x, result.screenPoint.y, {
            button: 'left',
            count: 1,
            dryRun: Boolean(args.dryRun),
          });
          return ok({ ...result, clicked });
        }),
      },

      {
        name: 'image_crop',
        title: 'Crop a PNG (and optionally rescale)',
        description:
          'Cut a rectangle out of a saved PNG and write it as a new file. Use this to turn a screenshot into a ' +
          'template for image_find, or to zoom into a region before sending it to a vision model.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'Path to the source PNG.' },
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            output: { type: 'string', description: 'Where to write the crop. Defaults to the screenshot folder.' },
            scale: { type: 'number', description: 'Rescale the crop by this factor (2 = double size). Default 1.' },
            mark: { type: 'boolean', description: 'Draw a red box on the source around the crop, saved alongside it.' },
          },
          required: ['source', 'x', 'y', 'width', 'height'],
        },
        handler: guard(async (args) => {
          const source = String(args.source);
          if (!fs.existsSync(source)) return fail(`source image not found: ${source}`);
          const image = decodePng(fs.readFileSync(source));
          const cut = crop(image, Number(args.x), Number(args.y), Number(args.width), Number(args.height));
          const scaled = args.scale && args.scale !== 1 ? resize(cut, cut.width * args.scale, cut.height * args.scale) : cut;
          const output = args.output
            ? path.resolve(String(args.output))
            : path.join(shotDir, `crop-${Date.now()}.png`);
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.writeFileSync(output, encodePng(scaled));
          const payload = {
            output,
            source,
            sourceSize: { width: image.width, height: image.height },
            crop: { x: Number(args.x), y: Number(args.y), width: cut.width, height: cut.height },
            outputSize: { width: scaled.width, height: scaled.height },
          };
          if (args.mark) {
            const marked = annotate(image, { box: { x: Number(args.x), y: Number(args.y), width: cut.width, height: cut.height } });
            const markedPath = output.replace(/\.png$/i, '') + '-marked.png';
            fs.writeFileSync(markedPath, encodePng(marked));
            payload.marked = markedPath;
          }
          return ok(payload);
        }),
      },

      // -------------------------------------------------------------------
      // Recognition — model driven
      // -------------------------------------------------------------------

      {
        name: 'vision_config',
        title: 'Vision provider status',
        description:
          'Show which multimodal provider is configured (the API key is redacted) and optionally send a tiny probe ' +
          'image to verify the endpoint really answers. Set test=true to probe.',
        inputSchema: {
          type: 'object',
          properties: {
            test: { type: 'boolean', description: 'Send a 2x2 probe image and report the raw reply. Default false.' },
          },
        },
        handler: guard(async (args) => {
          const summary = { ...describeVisionConfig(vision.config), configError: this.visionConfigError };
          if (!args.test) return ok(summary);
          if (!vision.available) return ok({ ...summary, probe: 'skipped: no provider configured' });
          const probe = { width: 2, height: 2, data: Buffer.alloc(2 * 2 * 4, 200) };
          try {
            const reply = await vision.complete({
              prompt: 'Reply with exactly {"ok":true} and nothing else.',
              imageBase64: encodePng(probe).toString('base64'),
            });
            return ok({ ...summary, probe: 'ok', reply: String(reply).slice(0, 300) });
          } catch (error) {
            return ok({ ...summary, probe: 'failed', error: error.message });
          }
        }),
      },

      {
        name: 'vision_locate',
        title: 'Find an element by description',
        description:
          'Take a screenshot, ask the configured vision model where the described element is, and return both the ' +
          'point in image space and the mapped screen coordinate. An annotated PNG is written next to the ' +
          'screenshot so you can confirm the model picked the right thing. Use mode="list" to get every match.',
        inputSchema: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'What to find, e.g. "the green Upload button".' },
            ...AREA,
            mode: { type: 'string', enum: ['point', 'list', 'describe'], description: 'Default point.' },
            maxWidth: { type: 'integer', description: 'Downscale the screenshot before sending. Default 1400.' },
            extra: { type: 'string', description: 'Extra context for the model.' },
            inline: { type: 'boolean', description: 'Return the annotated image in the response. Default false.' },
          },
          required: ['instruction'],
        },
        handler: guard(async (args) => {
          const result = await locateOnScreen({
            gui,
            vision,
            instruction: String(args.instruction),
            region: args.region,
            window: args.window,
            maxWidth: args.maxWidth ?? 1400,
            mode: args.mode ?? 'point',
            extra: args.extra,
            shotDir,
          });
          if (!args.inline || !result.annotated) return ok(result);
          return okImage(result, fs.readFileSync(result.annotated).toString('base64'));
        }),
      },

      {
        name: 'vision_click',
        title: 'Find an element and click it',
        description:
          'The core screenshot -> model -> click loop in one call. Locates the described element and clicks its ' +
          'centre, optionally offsetting by a few pixels. Set dryRun to see where it would click without clicking.',
        inputSchema: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: 'What to click, e.g. "the Upload toolbar button".' },
            ...AREA,
            maxWidth: { type: 'integer', description: 'Downscale before sending. Default 1400.' },
            offsetX: { type: 'integer', description: 'Pixels to add to the model X before clicking. Default 0.' },
            offsetY: { type: 'integer', description: 'Pixels to add to the model Y before clicking. Default 0.' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
            count: { type: 'integer', description: 'Default 1.' },
            dryRun: { type: 'boolean', description: 'Locate and report, but do not click.' },
            inline: { type: 'boolean', description: 'Return the annotated image. Default false.' },
          },
          required: ['instruction'],
        },
        handler: guard(async (args) => {
          const located = await locateOnScreen({
            gui,
            vision,
            instruction: String(args.instruction),
            region: args.region,
            window: args.window,
            maxWidth: args.maxWidth ?? 1400,
            mode: 'point',
            shotDir,
          });
          if (!located.found) return ok({ ...located, clicked: false });
          const point = {
            x: located.screenPoint.x + (args.offsetX ?? 0),
            y: located.screenPoint.y + (args.offsetY ?? 0),
          };
          const clicked = await gui.mouseClick(point.x, point.y, {
            button: args.button ?? 'left',
            count: args.count ?? 1,
            dryRun: Boolean(args.dryRun),
          });
          const payload = { ...located, clickPoint: point, clicked };
          if (!args.inline || !located.annotated) return ok(payload);
          return okImage(payload, fs.readFileSync(located.annotated).toString('base64'));
        }),
      },

      {
        name: 'vision_act',
        title: 'Run a goal with a vision loop',
        description:
          'Give a goal in plain language and let the model drive: it looks at the screen, picks one action, ' +
          'the server performs it, then it looks again — up to maxSteps times. Every step (decision, reason, ' +
          'screenshot) is returned for auditing. Always start with dryRun=true to see the plan, and pass an ' +
          '"allowed" list to restrict what it may do. Prefer targeted tools when you already know the steps.',
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: 'What to accomplish, e.g. "open the Extensions panel".' },
            ...AREA,
            maxSteps: { type: 'integer', description: 'Hard ceiling on actions. Default 8.' },
            maxWidth: { type: 'integer', description: 'Downscale before sending. Default 1400.' },
            settleMs: { type: 'integer', description: 'Pause after each action so the UI can react. Default 600.' },
            allowed: {
              type: 'array',
              items: { type: 'string' },
              description: `Actions the model may use. Default: ${DEFAULT_ACTIONS.join(', ')}.`,
            },
            dryRun: { type: 'boolean', description: 'Plan one action and stop, injecting nothing.' },
          },
          required: ['goal'],
        },
        handler: guard(async (args) =>
          ok(
            await runVisionLoop({
              gui,
              vision,
              goal: String(args.goal),
              region: args.region,
              window: args.window,
              maxWidth: args.maxWidth ?? 1400,
              maxSteps: args.maxSteps ?? 8,
              settleMs: args.settleMs ?? 600,
              allowed: args.allowed ?? DEFAULT_ACTIONS,
              dryRun: Boolean(args.dryRun),
              shotDir,
            }),
          ),
        ),
      },

      // -------------------------------------------------------------------
      // Cross-family session overview
      // -------------------------------------------------------------------

      {
        name: 'sessions_status',
        title: 'All session status',
        description:
          'Report every live session this server holds across all channels: serial, pty, ssh, mqtt and udp. ' +
          'Serial sessions are also reported by serial_status.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
        handler: async () =>
          ok({
            serial: [...sessions.values()].map((session) => session.status()),
            pty: [...ptySessions.values()].map((session) => session.status()),
            ssh: [...sshSessions.values()].map((session) => session.status()),
            mqtt: [...mqttSessions.values()].map((session) => session.status()),
            udp: [...udpSessions.values()].map((session) => session.status()),
          }),
      },
    ];
  }
}

export { HOME, APPROOT };
