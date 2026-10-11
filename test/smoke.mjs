/**
 * End-to-end smoke test: speaks MCP over stdio to src/index.js and exercises
 * the tools against the live Mind+ installation.
 *
 *   node test/smoke.mjs
 *
 * Requires Mind+ 2.0 to be running (mind-link on 127.0.0.1:19302 / :19303).
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.js');

const child = spawn(process.execPath, [entry, '--transport', 'stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;
let stderr = '';

child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log('[non-JSON on stdout]', line.slice(0, 200));
      continue;
    }
    const entryRef = pending.get(message.id);
    if (entryRef) {
      pending.delete(message.id);
      entryRef.resolve(message);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 120000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

function notify(method, params) {
  const payload = { jsonrpc: '2.0', method };
  if (params !== undefined) payload.params = params;
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function textOf(response) {
  return response?.result?.content?.map((part) => part.text).join('\n') ?? '';
}

try {
  // 1. initialize
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  record(
    'initialize',
    init.result?.serverInfo?.name === 'mindplus',
    `protocolVersion=${init.result?.protocolVersion} server=${init.result?.serverInfo?.name}`,
  );
  notify('notifications/initialized');

  // 2. tools/list
  const list = await request('tools/list', {});
  const names = (list.result?.tools ?? []).map((tool) => tool.name);
  const hasFamilies = ['pty_open', 'ssh_connect', 'mqtt_connect', 'udp_open', 'sessions_status'].every((name) =>
    names.includes(name),
  );
  record('tools/list', names.length >= 40 && hasFamilies, `${names.length} tools`);

  // 3. mindplus_info — proves the mind-link bridge is live
  const info = await request('tools/call', { name: 'info', arguments: {} });
  const infoText = textOf(info);
  record('tools/call info', !info.result?.isError && infoText.includes('LINKAPPROOT'), infoText.replace(/\s+/g, ' ').slice(0, 220));

  // The fs tools that do NOT expand %HOMEDIR% (rename) need real absolute paths.
  let home = '';
  try {
    home = JSON.parse(infoText)?.pathInfo?.HOMEDIR ?? '';
  } catch {
    home = '';
  }

  // 4. serial_list_ports
  const ports = await request('tools/call', { name: 'serial_list_ports', arguments: {} });
  record('tools/call serial_list_ports', !ports.result?.isError, textOf(ports).replace(/\s+/g, ' ').slice(0, 160));

  // 5. run_command — real process execution through mind-link
  const cmd = await request('tools/call', {
    name: 'run_command',
    arguments: { cmd: 'cmd.exe', args: ['/c', 'echo mindplus-mcp-ok'], timeoutMs: 20000 },
  });
  const cmdText = textOf(cmd);
  record('tools/call run_command', !cmd.result?.isError && cmdText.includes('mindplus-mcp-ok'), cmdText.replace(/\s+/g, ' ').slice(0, 200));

  // 6. fs round-trip
  const probePath = '%HOMEDIR%\\mindplus-mcp-smoke.txt';
  await request('tools/call', {
    name: 'fs_write_text',
    arguments: { path: probePath, content: 'hello from mindplus-mcp' },
  });
  const read = await request('tools/call', { name: 'fs_read_text', arguments: { path: probePath } });
  const readText = textOf(read);
  record('tools/call fs_write_text + fs_read_text', readText.includes('hello from mindplus-mcp'), readText.replace(/\s+/g, ' ').slice(0, 200));
  await request('tools/call', { name: 'fs_remove', arguments: { path: probePath } });

  // 6b. mkdir / rename / stat / remove round-trip. rename takes literal paths
  //     (mind-link does not run replacePath on it), so use absolute paths.
  if (home) {
    const dirA = `${home}\\mindplus-mcp-smoke-a`;
    const dirB = `${home}\\mindplus-mcp-smoke-b`;
    const mk = await request('tools/call', { name: 'fs_mkdir', arguments: { path: dirA } });
    const mv = await request('tools/call', { name: 'fs_rename', arguments: { from: dirA, to: dirB } });
    const st = await request('tools/call', { name: 'fs_stat', arguments: { path: dirB } });
    const rm = await request('tools/call', { name: 'fs_remove', arguments: { path: dirB, directory: true } });
    const gone = await request('tools/call', { name: 'fs_stat', arguments: { path: dirB } });
    record(
      'tools/call fs_mkdir + fs_rename + fs_stat + fs_remove',
      !mk.result?.isError &&
        !mv.result?.isError &&
        !st.result?.isError &&
        !rm.result?.isError &&
        gone.result?.isError === true,
      `stat-after-remove isError=${gone.result?.isError}`,
    );
  } else {
    record('tools/call fs_mkdir + fs_rename + fs_stat + fs_remove', false, 'could not read HOMEDIR from info');
  }

  // 6c. the bundled arduino-cli runs and picks up Mind+'s own config file
  const cliVer = await request('tools/call', { name: 'arduino_cli', arguments: { args: ['version'] } });
  record(
    'tools/call arduino_cli version',
    !cliVer.result?.isError && /arduino-cli/i.test(textOf(cliVer)),
    textOf(cliVer).replace(/\s+/g, ' ').slice(0, 140),
  );

  const cliCfg = await request('tools/call', { name: 'arduino_cli', arguments: { args: ['config', 'dump'] } });
  const cfgText = textOf(cliCfg);
  record(
    'tools/call arduino_cli uses Mind+ config',
    !cliCfg.result?.isError && /mind\+/i.test(cfgText) && /Arduino/i.test(cfgText),
    cfgText.replace(/\s+/g, ' ').slice(0, 200),
  );

  // 6d. opening a nonexistent port must fail fast: mind-link reports `error`
  //     (or `close`) immediately, and serial_open must not wait out openTimeoutMs.
  const startedAt = Date.now();
  const badPort = await request('tools/call', {
    name: 'serial_open',
    arguments: { port: 'COM255', openTimeoutMs: 8000 },
  });
  const elapsed = Date.now() - startedAt;
  record(
    'tools/call serial_open fails fast on a bad port',
    badPort.result?.isError === true && elapsed < 5000,
    `isError=${badPort.result?.isError} elapsed=${elapsed}ms`,
  );
  await request('tools/call', { name: 'serial_close', arguments: { port: 'COM255' } });

  // 6e. node-pty: run a real interactive terminal session
  await request('tools/call', {
    name: 'pty_open',
    arguments: { id: 'smoke-pty', cmd: 'cmd.exe', args: ['/c', 'echo pty-ok'] },
  });
  const ptyRead = await request('tools/call', { name: 'pty_read', arguments: { id: 'smoke-pty', timeoutMs: 5000 } });
  const ptyText = textOf(ptyRead);
  record(
    'tools/call pty_open + pty_read',
    !ptyRead.result?.isError && ptyText.includes('pty-ok'),
    ptyText.replace(/\s+/g, ' ').slice(0, 140),
  );
  await request('tools/call', { name: 'pty_kill', arguments: { id: 'smoke-pty' } });

  // 6f. UDP: bind a socket, send a datagram to ourselves, read it back
  const udpPort = 39000 + Math.floor(Math.random() * 2000);
  await request('tools/call', { name: 'udp_open', arguments: { id: 'smoke-udp' } });
  await request('tools/call', {
    name: 'udp_bind',
    arguments: { id: 'smoke-udp', port: udpPort, ip: '127.0.0.1' },
  });
  await request('tools/call', {
    name: 'udp_send',
    arguments: { id: 'smoke-udp', message: 'udp-smoke-ok', port: udpPort, address: '127.0.0.1' },
  });
  const udpRead = await request('tools/call', { name: 'udp_read', arguments: { id: 'smoke-udp', timeoutMs: 5000 } });
  const udpText = textOf(udpRead);
  record(
    'tools/call udp_open + udp_bind + udp_send + udp_read',
    !udpRead.result?.isError && udpText.includes('udp-smoke-ok'),
    udpText.replace(/\s+/g, ' ').slice(0, 180),
  );
  await request('tools/call', { name: 'udp_close', arguments: { id: 'smoke-udp' } });

  // 6g. ssh_connect against a dead port fails fast; without a username it must
  //     fail immediately, because ssh2 validates its config synchronously and
  //     mind-link drops the call without replying when that throws.
  const sshStarted = Date.now();
  const sshBad = await request('tools/call', {
    name: 'ssh_connect',
    arguments: { id: 'smoke-ssh', host: '127.0.0.1', port: 1, username: 'root', timeoutMs: 6000 },
  });
  const sshElapsed = Date.now() - sshStarted;
  const sshNoUser = await request('tools/call', {
    name: 'ssh_connect',
    arguments: { id: 'smoke-ssh2', host: '127.0.0.1', port: 1 },
  });
  record(
    'tools/call ssh_connect fails fast',
    sshBad.result?.isError === true && sshElapsed < 5000 && sshNoUser.result?.isError === true,
    `elapsed=${sshElapsed}ms, no-username isError=${sshNoUser.result?.isError}`,
  );

  // 6h. mqtt_connect against a dead broker reports the broker error quickly
  const mqttStarted = Date.now();
  const mqttBad = await request('tools/call', {
    name: 'mqtt_connect',
    arguments: { id: 'smoke-mqtt', url: 'mqtt://127.0.0.1:1', timeoutMs: 6000 },
  });
  const mqttElapsed = Date.now() - mqttStarted;
  record(
    'tools/call mqtt_connect fails fast',
    mqttBad.result?.isError === true && mqttElapsed < 5000 && /ECONNREFUSED|refused|failed/i.test(textOf(mqttBad)),
    `elapsed=${mqttElapsed}ms`,
  );

  // 6i. sessions_status covers every channel
  const statuses = await request('tools/call', { name: 'sessions_status', arguments: {} });
  const statusText = textOf(statuses);
  record(
    'tools/call sessions_status',
    !statuses.result?.isError &&
      ['serial', 'pty', 'ssh', 'mqtt', 'udp'].every((key) => statusText.includes(`"${key}"`)),
    statusText.replace(/\s+/g, ' ').slice(0, 120),
  );

  // 7. unknown tool -> tool-level error, not a crash
  const bad = await request('tools/call', { name: 'definitely_not_a_tool', arguments: {} });
  record('unknown tool reports an error', Boolean(bad.error), bad.error?.message ?? '');
} catch (error) {
  record('harness', false, error.message);
} finally {
  child.stdin.end();
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (stderr.trim()) {
    console.log('\n--- server stderr ---');
    console.log(stderr.trim());
  }
  const failed = results.filter((item) => !item.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
