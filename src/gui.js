/**
 * GUI automation for mindplus-mcp — screen capture, mouse, keyboard, windows.
 *
 * Everything here is Windows-only and implemented by driving a long-lived
 * PowerShell process (src/gui-host.ps1) over a JSON-lines protocol. A persistent
 * host matters: the C# core is compiled once by Add-Type, so a
 * capture -> locate -> click loop costs one round trip per step instead of
 * paying process + JIT startup every time.
 *
 * No npm dependencies: PowerShell 5.1 ships with Windows, and the Win32 calls
 * (SendInput, CopyFromScreen, EnumWindows, ...) are P/Invoke'd from C#.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOST_SCRIPT = path.join(HERE, 'gui-host.ps1');

export function guiSupported() {
  return process.platform === 'win32';
}

/** Best-effort path to Windows PowerShell 5.1 (present on every supported Windows). */
function powershellPath() {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (root) {
    const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(full)) return full;
  }
  return 'powershell.exe';
}

export class GuiError extends Error {}
export class GuiUnsupportedError extends GuiError {}

export function defaultShotDir() {
  return path.join(os.tmpdir(), 'mindplus-mcp', 'shots');
}

/**
 * A handle to the persistent PowerShell GUI host.
 *
 * The host is started lazily on first use and restarted automatically if it
 * dies (a wedged input queue is a real failure mode after a UAC prompt).
 */
export class GuiHost {
  constructor({ timeoutMs = 30000, shotDir = defaultShotDir(), keepShots = 200, logger } = {}) {
    this.timeoutMs = timeoutMs;
    this.shotDir = shotDir;
    this.keepShots = keepShots;
    this.logger = logger;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.starting = null;
    this.info = null;
  }

  assertSupported() {
    if (!guiSupported()) {
      throw new GuiUnsupportedError(
        `GUI automation is Windows-only (current platform: ${process.platform}). ` +
          'The mind-link channels (serial/ssh/pty/...) still work everywhere.',
      );
    }
    if (!fs.existsSync(HOST_SCRIPT)) {
      throw new GuiError(`GUI host script is missing: ${HOST_SCRIPT}`);
    }
  }

  async start() {
    this.assertSupported();
    if (this.child && !this.child.killed) return this.info;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      fs.mkdirSync(this.shotDir, { recursive: true });
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        HOST_SCRIPT,
      ];
      const child = spawn(powershellPath(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          // Ask Windows for DPI awareness at process start; the C# core also
          // tries at runtime, but the shim is the reliable path for a console app.
          __COMPAT_LAYER: 'HIGHDPIAWARE',
        },
      });
      this.child = child;
      this.buffer = '';
      this.stderr = '';

      const ready = new Promise((resolve, reject) => {
        this.readyResolve = resolve;
        this.readyReject = reject;
        setTimeout(() => reject(new GuiError('timed out waiting for the GUI host to start')), 60000).unref?.();
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.#onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderr = (this.stderr + chunk).slice(-8000);
      });
      child.on('error', (error) => {
        this.#failAll(new GuiError(`GUI host failed to start: ${error.message}`));
      });
      child.on('close', (code) => {
        const detail = this.stderr.trim() ? `\n${this.stderr.trim().slice(-2000)}` : '';
        this.child = null;
        this.info = null;
        this.#failAll(new GuiError(`GUI host exited (code ${code})${detail}`));
      });

      this.info = await ready;
      return this.info;
    })();

    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  #onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Add-Type warnings can leak onto stdout on odd PowerShell builds.
        if (this.logger) this.logger(`gui-host: ignoring non-JSON line: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.ready) {
        if (this.readyResolve) this.readyResolve(message);
        continue;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) continue;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.result);
      else waiter.reject(new GuiError(String(message.error ?? 'unknown GUI host error')));
    }
  }

  #failAll(error) {
    if (this.readyReject) {
      this.readyReject(error);
      this.readyReject = null;
    }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async request(cmd, args = {}, { timeoutMs } = {}) {
    await this.start();
    const id = this.nextId++;
    const limit = timeoutMs ?? this.timeoutMs;
    const payload = JSON.stringify({ id, cmd, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GuiError(`GUI host did not answer "${cmd}" within ${limit}ms`));
      }, limit);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${payload}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new GuiError(`failed to send "${cmd}" to the GUI host: ${error.message}`));
      }
    });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.info = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 1500);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // convenience wrappers
  // -------------------------------------------------------------------------

  screenInfo() {
    return this.request('screen_info', {});
  }

  monitors() {
    return this.request('monitors', {});
  }

  cursorPos() {
    return this.request('cursor_pos', {});
  }

  pixelColor(x, y) {
    return this.request('pixel_color', { x: Math.round(x), y: Math.round(y) });
  }

  async capture({ x = 0, y = 0, width, height, format = 'png', quality = 90, handle, printWindow = true, file } = {}) {
    if (!width || !height) {
      const info = await this.screenInfo();
      const bounds = handle ? await this.windowRect(handle) : null;
      if (bounds) {
        x = bounds.x;
        y = bounds.y;
        width = bounds.width;
        height = bounds.height;
      } else {
        x = info.virtualDesktop.x;
        y = info.virtualDesktop.y;
        width = info.virtualDesktop.width;
        height = info.virtualDesktop.height;
      }
    }
    const target = file ?? this.nextShotPath(format);
    const result = await this.request(
      'capture',
      {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        path: target,
        format,
        quality,
        handle: handle ?? null,
        printWindow: Boolean(printWindow),
      },
      { timeoutMs: Math.max(this.timeoutMs, 30000) },
    );
    this.pruneShots();
    return result;
  }

  nextShotPath(format = 'png') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 7);
    return path.join(this.shotDir, `shot-${stamp}-${random}.${format === 'jpg' || format === 'jpeg' ? 'jpg' : 'png'}`);
  }

  pruneShots() {
    try {
      const entries = fs
        .readdirSync(this.shotDir)
        .filter((name) => name.startsWith('shot-'))
        .map((name) => {
          const full = path.join(this.shotDir, name);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const entry of entries.slice(this.keepShots)) fs.unlinkSync(entry.full);
    } catch {
      /* pruning is best effort */
    }
  }

  mouseMove(x, y, { durationMs = 0, dryRun = false } = {}) {
    return this.request('mouse_move', { x: Math.round(x), y: Math.round(y), durationMs, dryRun });
  }

  mouseClick(x, y, { button = 'left', count = 1, intervalMs = 60, holdMs = 0, dryRun = false } = {}) {
    return this.request('mouse_click', {
      x: Math.round(x),
      y: Math.round(y),
      button,
      count,
      intervalMs,
      holdMs,
      dryRun,
    });
  }

  mouseButton(x, y, { button = 'left', down = true, dryRun = false } = {}) {
    return this.request('mouse_button', {
      x: x === undefined || x === null ? -1 : Math.round(x),
      y: y === undefined || y === null ? -1 : Math.round(y),
      button,
      down,
      dryRun,
    });
  }

  mouseDrag(fromX, fromY, toX, toY, { durationMs = 300, button = 'left', dryRun = false } = {}) {
    return this.request('mouse_drag', {
      fromX: Math.round(fromX),
      fromY: Math.round(fromY),
      toX: Math.round(toX),
      toY: Math.round(toY),
      durationMs,
      button,
      dryRun,
    });
  }

  mouseScroll(x, y, { deltaV = 0, deltaH = 0, dryRun = false } = {}) {
    return this.request('mouse_scroll', {
      x: Math.round(x),
      y: Math.round(y),
      deltaV: Math.round(deltaV),
      deltaH: Math.round(deltaH),
      dryRun,
    });
  }

  keyPress(combo, { dryRun = false } = {}) {
    return this.request('key_press', { combo: String(combo), dryRun });
  }

  keyType(text, { delayMs = 0, dryRun = false } = {}) {
    return this.request('key_type', { text: String(text), delayMs, dryRun });
  }

  clipboardGet() {
    return this.request('clipboard_get', {});
  }

  clipboardSet(text) {
    return this.request('clipboard_set', { text: String(text) });
  }

  windowList({ visibleOnly = true, titledOnly = true, includeCloaked = false, includeOwned = false } = {}) {
    return this.request('window_list', { visibleOnly, titledOnly, includeCloaked, includeOwned });
  }

  windowRect(handle) {
    return this.request('window_rect', { handle: String(handle) });
  }

  windowActivate(handle, { waitMs = 150 } = {}) {
    return this.request('window_activate', { handle: String(handle), waitMs });
  }

  /** Find a window by handle, exact title, or title substring (case-insensitive). */
  async findWindow(query) {
    const wanted = String(query).trim();
    const { windows } = await this.windowList({ visibleOnly: true, titledOnly: true });
    if (/^(0x)?[0-9a-f]+$/i.test(wanted) && /^0x/i.test(wanted)) {
      const handle = wanted.toLowerCase();
      const exact = windows.find((w) => w.handle.toLowerCase() === handle);
      if (exact) return exact;
    }
    const lower = wanted.toLowerCase();
    return (
      windows.find((w) => w.title === wanted) ??
      windows.find((w) => w.title.toLowerCase().includes(lower)) ??
      windows.find((w) => (w.process ?? '').toLowerCase() === lower) ??
      null
    );
  }
}
