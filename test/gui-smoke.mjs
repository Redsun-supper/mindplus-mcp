/**
 * End-to-end smoke test for the GUI automation + recognition families.
 *
 *   node test/gui-smoke.mjs
 *
 * Windows only. It talks to the real desktop, so it is deliberately careful:
 *   - clicks are only ever issued with dryRun, so nothing on your screen is hit
 *   - the cursor is moved back to where it started
 *   - the clipboard is saved and restored
 *   - screenshots land in a temp folder, never in the project
 *
 * The vision half runs against test/fixtures/fake-vision.mjs, so no API key and
 * no network access are needed.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.js');
const fakeVision = path.join(here, 'fixtures', 'fake-vision.mjs');
const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindplus-gui-smoke-'));

if (process.platform !== 'win32') {
  console.log(`SKIP  GUI automation is Windows-only (running on ${process.platform})`);
  process.exit(0);
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Start the server over stdio and return a tiny MCP client. */
function connect(extraArgs = []) {
  const child = spawn(process.execPath, [entry, '--transport', 'stdio', ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { buffer: '', pending: new Map(), nextId: 1, stderr: '' };
  child.stderr.on('data', (chunk) => (state.stderr += chunk));
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk.toString('utf8');
    let index;
    while ((index = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, index).trim();
      state.buffer = state.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        console.log('[non-JSON on stdout]', line.slice(0, 200));
        continue;
      }
      const waiter = state.pending.get(message.id);
      if (waiter) {
        state.pending.delete(message.id);
        waiter(message);
      }
    }
  });
  const request = (method, params) => {
    const id = state.nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 180000);
      state.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  };
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    const text = response?.result?.content?.map((part) => part.text).join('\n') ?? '';
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not every tool answers with JSON */
    }
    return { isError: Boolean(response?.result?.isError), text, json, raw: response };
  };
  const stop = async () => {
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return { request, call, stop, state };
}

const EXPECTED_TOOLS = [
  'screen_info',
  'screen_capture',
  'screen_pixel',
  'screen_wait_change',
  'mouse_move',
  'mouse_click',
  'mouse_drag',
  'mouse_scroll',
  'mouse_button',
  'keyboard_type',
  'keyboard_press',
  'clipboard_read',
  'clipboard_write',
  'window_list',
  'window_rect',
  'window_activate',
  'image_find',
  'pixel_find',
  'image_crop',
  'vision_config',
  'vision_locate',
  'vision_click',
  'vision_act',
];

const plain = connect(['--vision-provider', 'none', '--shot-dir', shotDir]);
let originalClipboard = null;
let originalCursor = null;

try {
  await plain.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'gui-smoke', version: '0.0.0' },
  });

  // ---- tool catalog --------------------------------------------------------
  const list = await plain.request('tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
  record('tools/list exposes the GUI + vision family', missing.length === 0, `${names.length} tools, missing: ${missing.join(', ') || 'none'}`);

  // ---- screen observation --------------------------------------------------
  const info = await plain.call('screen_info');
  record(
    'screen_info reports monitors and DPI',
    !info.isError && Array.isArray(info.json?.monitors) && info.json.monitors.length >= 1,
    `${info.json?.monitors?.length} monitor(s), awareness=${info.json?.awareness}, vision=${info.json?.vision?.provider}`,
  );
  const monitor = info.json.monitors[0];
  const testRegion = {
    x: Math.min(0, monitor.x) >= 0 ? monitor.x : 0,
    y: monitor.y,
    width: 400,
    height: 300,
  };

  // park the cursor far away from the test region so it never lands in a template
  originalCursor = info.json.cursor;
  await plain.call('mouse_move', { x: monitor.x + monitor.width - 40, y: monitor.y + monitor.height - 60 });

  const capture = await plain.call('screen_capture', { region: testRegion });
  const captured = capture.json;
  record(
    'screen_capture writes a PNG of the requested size',
    !capture.isError && captured?.width === 400 && captured?.height === 300 && fs.existsSync(captured.path) && captured.bytes > 0,
    `${captured?.path} (${captured?.bytes} bytes)`,
  );

  const pixel = await plain.call('screen_pixel', { x: testRegion.x, y: testRegion.y });
  record('screen_pixel returns a hex colour', !pixel.isError && /^#[0-9A-F]{6}$/.test(pixel.json?.hex ?? ''), pixel.json?.hex);

  const windows = await plain.call('window_list', { filter: 'mind' });
  const anyWindows = await plain.call('window_list', {});
  record(
    'window_list enumerates and filters windows',
    !anyWindows.isError && Array.isArray(anyWindows.json?.windows) && anyWindows.json.windows.length > 0,
    `${anyWindows.json?.count} windows total, ${windows.json?.count} match "mind"`,
  );
  const firstWindow = anyWindows.json.windows[0];
  const rect = await plain.call('window_rect', { window: firstWindow.handle });
  record(
    'window_rect resolves a handle to bounds',
    !rect.isError && rect.json?.width > 0 && rect.json?.height > 0,
    `${JSON.stringify(rect.json?.title)} ${rect.json?.width}x${rect.json?.height}`,
  );

  // ---- input (nothing is actually clicked) --------------------------------
  const before = (await plain.call('screen_info')).json.cursor;
  const move = await plain.call('mouse_move', { x: before.x + 4, y: before.y + 4 });
  const after = (await plain.call('screen_info')).json.cursor;
  record('mouse_move actually moves the cursor', !move.isError && after.x === before.x + 4 && after.y === before.y + 4, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  const click = await plain.call('mouse_click', { x: 10, y: 10, count: 2, dryRun: true });
  record('mouse_click dryRun plans without clicking', !click.isError && click.json?.dryRun === true && click.json?.count === 2);
  const drag = await plain.call('mouse_drag', { fromX: 10, fromY: 10, toX: 60, toY: 60, dryRun: true });
  record('mouse_drag dryRun plans without dragging', !drag.isError && drag.json?.dryRun === true);
  const scroll = await plain.call('mouse_scroll', { x: 10, y: 10, deltaV: -3, dryRun: true });
  record('mouse_scroll dryRun plans without scrolling', !scroll.isError && scroll.json?.deltaV === -3);
  const press = await plain.call('keyboard_press', { keys: 'ctrl+shift+s', dryRun: true });
  record(
    'keyboard_press resolves a chord to virtual keys',
    !press.isError && JSON.stringify(press.json?.vk) === '[17,16,83]',
    JSON.stringify(press.json?.vk),
  );
  const typed = await plain.call('keyboard_type', { text: 'hello 世界', dryRun: true });
  record('keyboard_type dryRun counts characters', !typed.isError && typed.json?.dryRun === true && typed.json?.length === 8, `length=${typed.json?.length}`);
  const badKey = await plain.call('keyboard_press', { keys: 'notakey', dryRun: true });
  record('keyboard_press rejects an unknown key name', badKey.isError && /unknown key/.test(badKey.text), badKey.text.slice(0, 80));

  // ---- clipboard (saved and restored) -------------------------------------
  originalClipboard = (await plain.call('clipboard_read')).json;
  const marker = `mindplus-gui-smoke-${Date.now()}`;
  const wrote = await plain.call('clipboard_write', { text: marker });
  const readBack = await plain.call('clipboard_read');
  record(
    'clipboard write/read round trip',
    !wrote.isError && readBack.json?.text === marker && readBack.json?.length === marker.length,
    `wrote ${marker.length} chars, read back ${readBack.json?.length} chars`,
  );

  // ---- local recognition, fully deterministic -----------------------------
  const crop = await plain.call('image_crop', {
    source: captured.path,
    x: 120,
    y: 90,
    width: 60,
    height: 40,
    output: path.join(shotDir, 'template.png'),
  });
  record('image_crop cuts a template PNG', !crop.isError && fs.existsSync(crop.json?.output), crop.json?.output);

  const found = await plain.call('image_find', {
    template: crop.json.output,
    source: captured.path,
    sourceOrigin: { x: testRegion.x, y: testRegion.y },
    minScore: 0.99,
  });
  record(
    'image_find locates a template cut from the same screenshot',
    !found.isError && found.json?.found === true && found.json.score === 1,
    `score=${found.json?.score} screenPoint=${JSON.stringify(found.json?.screenPoint)}`,
  );
  record(
    'image_find maps the match back to screen coordinates',
    found.json?.screenPoint?.x === testRegion.x + 150 && found.json?.screenPoint?.y === testRegion.y + 110,
    JSON.stringify(found.json?.screenPoint),
  );

  // a template that cannot be present must be reported as a miss, not guessed at
  const tiny = await plain.call('image_crop', {
    source: captured.path,
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    output: path.join(shotDir, 'tiny.png'),
  });
  const missed = await plain.call('image_find', {
    template: crop.json.output,
    source: tiny.json.output,
    minScore: 0.9,
  });
  record(
    'image_find reports a miss instead of guessing',
    !missed.isError && missed.json?.found === false,
    missed.json?.reason ?? '',
  );

  // searchRegion must actually restrict where we look
  const restricted = await plain.call('image_find', {
    template: crop.json.output,
    source: captured.path,
    sourceOrigin: { x: testRegion.x, y: testRegion.y },
    searchRegion: { x: 200, y: 200, width: 100, height: 80 },
    minScore: 0.99,
  });
  record(
    'image_find honours searchRegion',
    !restricted.isError && restricted.json?.found === false,
    restricted.json?.reason ?? `found=${restricted.json?.found}`,
  );

  const colorHit = await plain.call('pixel_find', {
    color: pixel.json.hex,
    tolerance: 0,
    source: captured.path,
    sourceOrigin: { x: testRegion.x, y: testRegion.y },
  });
  record('pixel_find finds the colour of a known pixel', !colorHit.isError && colorHit.json?.found === true && colorHit.json.count >= 1, `count=${colorHit.json?.count}`);

  // ---- waiting for the screen to settle -----------------------------------
  const settled = await plain.call('screen_wait_change', { region: testRegion, timeoutMs: 900, intervalMs: 200 });
  record('screen_wait_change times out cleanly when nothing moves', !settled.isError && settled.json?.changed === false, `elapsed=${settled.json?.elapsedMs}ms`);

  // ---- vision tools without a provider ------------------------------------
  const config = await plain.call('vision_config');
  record('vision_config reports provider=none', !config.isError && config.json?.provider === 'none' && config.json?.configured === false);
  const locateNoProvider = await plain.call('vision_locate', { instruction: 'the OK button', region: testRegion });
  record(
    'vision_locate explains that no provider is configured',
    locateNoProvider.isError && /no vision provider/i.test(locateNoProvider.text) && /image_find/.test(locateNoProvider.text),
    locateNoProvider.text.slice(0, 120),
  );
  const actNoProvider = await plain.call('vision_act', { goal: 'press OK', region: testRegion, dryRun: true });
  record('vision_act refuses to run without a provider', actNoProvider.isError && /vision provider/i.test(actNoProvider.text), actNoProvider.text.slice(0, 100));

  // ---- vision tools with the fake provider --------------------------------
  const command = `"${process.execPath}" "${fakeVision}" "{image}" --prompt "{prompt}"`;
  const withVision = connect([
    '--vision-provider',
    'command',
    '--vision-command',
    command,
    '--shot-dir',
    shotDir,
  ]);
  try {
    await withVision.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'gui-smoke', version: '0.0.0' },
    });

    const vconfig = await withVision.call('vision_config', { test: true });
    record(
      'vision_config with a command provider probes successfully',
      !vconfig.isError && vconfig.json?.provider === 'command' && vconfig.json?.probe === 'ok',
      `probe=${vconfig.json?.probe} reply=${String(vconfig.json?.reply).slice(0, 40)}`,
    );

    const located = await withVision.call('vision_locate', { instruction: 'the fake target', region: testRegion, maxWidth: 0 });
    record(
      'vision_locate maps the model point to screen coordinates',
      !located.isError && located.json?.found === true && located.json.screenPoint.x === testRegion.x + 40 && located.json.screenPoint.y === testRegion.y + 25,
      `screenPoint=${JSON.stringify(located.json?.screenPoint)} confidence=${located.json?.confidence}`,
    );
    record(
      'vision_locate writes an annotated PNG and passes the prompt through',
      Boolean(located.json?.annotated && fs.existsSync(located.json.annotated)) && /"promptHasTarget":true/.test(located.json?.reasoning ?? ''),
      located.json?.annotated,
    );

    const vclick = await withVision.call('vision_click', { instruction: 'the fake target', region: testRegion, maxWidth: 0, dryRun: true });
    record(
      'vision_click dryRun locates and plans without clicking',
      !vclick.isError && vclick.json?.found === true && vclick.json?.clicked?.dryRun === true && vclick.json.clickPoint.x === testRegion.x + 40,
      `clickPoint=${JSON.stringify(vclick.json?.clickPoint)}`,
    );

    const vact = await withVision.call('vision_act', { goal: 'press the fake button', region: testRegion, maxWidth: 0, dryRun: true, maxSteps: 3 });
    record(
      'vision_act dryRun plans exactly one step and injects nothing',
      !vact.isError && vact.json?.outcome === 'dry-run' && vact.json?.steps?.length === 1 && vact.json.steps[0].decision === 'click',
      `outcome=${vact.json?.outcome} steps=${vact.json?.steps?.length}`,
    );

    const badList = await withVision.call('vision_locate', { instruction: 'x', region: testRegion, mode: 'list', maxWidth: 0 });
    record('vision_locate list mode returns an array', !badList.isError && Array.isArray(badList.json?.elements), `${badList.json?.elements?.length} elements`);
  } finally {
    await withVision.stop();
  }
} catch (error) {
  record('harness completed without throwing', false, error.message);
  console.error(error.stack);
} finally {
  // restore everything we touched
  if (originalClipboard !== null) {
    await plain.call('clipboard_write', { text: originalClipboard ?? '' }).catch(() => {});
  }
  if (originalCursor) {
    await plain.call('mouse_move', { x: originalCursor.x, y: originalCursor.y }).catch(() => {});
  }
  await plain.stop();
  try {
    fs.rmSync(shotDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const failed = results.filter((item) => !item.passed);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failed checks:');
  for (const item of failed) console.log(`  - ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
}
process.exit(failed.length ? 1 : 0);
