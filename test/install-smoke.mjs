/**
 * Regression test for install.mjs.
 *
 * Everything happens inside a throwaway temp directory, so this never touches
 * the real MCP client configs on this machine.
 *
 *   node test/install-smoke.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(here, '..', 'install.mjs');
const entry = path.join(here, '..', 'src', 'index.js');

const results = [];
function record(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Run the installer inside a sandbox: HOME / USERPROFILE / APPDATA all point at
 * the throwaway temp dir, so client auto-discovery finds nothing real. Without
 * this the "no --target" default would also act on the developer's own
 * ~/.claude.json and ~/.dsh/profiles/*, and the --uninstall cases would strip
 * their real registrations.
 */
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [installer, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: work,
        USERPROFILE: work,
        APPDATA: path.join(work, 'AppData', 'Roaming'),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => resolve({ code: null, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function runJson(args) {
  const result = await run([...args, '--json']);
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    /* reported by the caller */
  }
  return { ...result, json };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mindplus-install-'));
const jsonFile = path.join(work, 'mcp.json');
const yamlFile = path.join(work, 'cordis.patch.yml');

const seededJson = `{
    "mcpServers": {
        "someone-else": {
            "command": "other.exe",
            "args": []
        }
    },
    "unrelatedTopLevelKey": true
}
`;
const seededYaml = `- id: keep-me
  name: "@foo/bar"
  config:
    a: 1
`;

try {
  // ---- Isolation guard ---------------------------------------------------
  // Every discovered target must be absent inside the sandbox. If this ever
  // fails, the rest of the suite is about to edit the developer's real configs.
  const isolation = await runJson(['--list']);
  const visible = (isolation.json?.detected ?? []).filter((item) => item.present).map((item) => item.id);
  record(
    'sandbox: no real client config is visible',
    isolation.code === 0 && visible.length === 0,
    visible.length ? `leaked: ${visible.join(',')}` : 'clean',
  );

  // ---- JSON target -------------------------------------------------------
  fs.writeFileSync(jsonFile, seededJson, 'utf8');

  const added = await runJson(['--config', jsonFile]);
  const afterAdd = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const mine = afterAdd.mcpServers?.mindplus;
  record(
    'json: adds the server entry',
    added.code === 0 &&
      added.json?.results?.[0]?.status === 'added' &&
      mine?.command === process.execPath &&
      Array.isArray(mine?.args) &&
      mine.args[0] === entry,
    `status=${added.json?.results?.[0]?.status} args0=${mine?.args?.[0]}`,
  );
  record(
    'json: preserves existing servers and unrelated keys',
    afterAdd.mcpServers?.['someone-else']?.command === 'other.exe' && afterAdd.unrelatedTopLevelKey === true,
    `keys=${Object.keys(afterAdd.mcpServers ?? {}).join(',')}`,
  );
  record(
    'json: preserves the original 4-space indent',
    fs.readFileSync(jsonFile, 'utf8').includes('\n    "mcpServers"'),
    'indent check',
  );

  const again = await runJson(['--config', jsonFile]);
  record('json: is idempotent', again.json?.results?.[0]?.status === 'unchanged', `status=${again.json?.results?.[0]?.status}`);

  const dry = await runJson(['--config', jsonFile, '--dry-run', '--name', 'ghost']);
  const afterDry = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  record(
    'json: --dry-run writes nothing',
    dry.json?.results?.[0]?.status === 'would-add' && afterDry.mcpServers?.ghost === undefined,
    `status=${dry.json?.results?.[0]?.status}`,
  );

  const removed = await runJson(['--config', jsonFile, '--uninstall']);
  const afterRemove = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  record(
    'json: uninstall removes only our entry',
    removed.json?.results?.[0]?.status === 'removed' &&
      afterRemove.mcpServers?.mindplus === undefined &&
      afterRemove.mcpServers?.['someone-else']?.command === 'other.exe',
    `remaining=${Object.keys(afterRemove.mcpServers ?? {}).join(',')}`,
  );

  // ---- YAML (DSH-style) target -------------------------------------------
  fs.writeFileSync(yamlFile, seededYaml, 'utf8');

  const yamlAdded = await runJson(['--config', yamlFile]);
  const yamlText = fs.readFileSync(yamlFile, 'utf8');
  record(
    'yaml: appends a DSH patch block',
    yamlAdded.code === 0 &&
      yamlAdded.json?.results?.[0]?.status === 'added' &&
      yamlText.includes('- id: mcp-mindplus') &&
      yamlText.includes('serverName: mindplus') &&
      yamlText.includes('failOnStartupError: false'),
    `status=${yamlAdded.json?.results?.[0]?.status}`,
  );
  record('yaml: keeps the pre-existing block', yamlText.includes('- id: keep-me'), 'keep-me present');

  const yamlAgain = await runJson(['--config', yamlFile]);
  record(
    'yaml: is idempotent',
    yamlAgain.json?.results?.[0]?.status === 'unchanged' &&
      (fs.readFileSync(yamlFile, 'utf8').match(/- id: mcp-mindplus/g) ?? []).length === 1,
    `status=${yamlAgain.json?.results?.[0]?.status}`,
  );

  const yamlRemoved = await runJson(['--config', yamlFile, '--uninstall']);
  const yamlAfter = fs.readFileSync(yamlFile, 'utf8');
  record(
    'yaml: uninstall strips our block',
    yamlRemoved.json?.results?.[0]?.status === 'removed' &&
      !yamlAfter.includes('mcp-mindplus') &&
      yamlAfter.includes('- id: keep-me'),
    `status=${yamlRemoved.json?.results?.[0]?.status}`,
  );

  // ---- YAML target with an INDENTED (nested) entry ------------------------
  // DSH patch entries often live inside a top-level `insert:` list, so the
  // `- id:` line carries leading whitespace. Missing that case makes the
  // installer append a SECOND copy of the entry next to the existing one —
  // which is exactly what happened against a live profile.
  const nestedFile = path.join(work, 'nested.patch.yml');
  const seededNested = [
    '- id: some-plugin',
    '  name: "@x/y"',
    '  config:',
    '    a: 1',
    '- insert:',
    '  - id: tool-a',
    '    name: "@x/tool-a"',
    '  - id: mcp-mindplus',
    '    name: "@deepseek-ai/dsh-mcp-client"',
    '    config:',
    '      serverName: mindplus',
    '      transport: stdio',
    "      command: 'C:\\Program Files\\nodejs\\node.exe'",
    '      failOnStartupError: false',
    '  - id: tool-b',
    '    name: "@x/tool-b"',
    '',
  ].join('\n');
  fs.writeFileSync(nestedFile, seededNested, 'utf8');

  const nestedAgain = await runJson(['--config', nestedFile]);
  record(
    'yaml: recognises an indented (nested) entry',
    nestedAgain.json?.results?.[0]?.status === 'unchanged' &&
      (fs.readFileSync(nestedFile, 'utf8').match(/mcp-mindplus/g) ?? []).length === 1,
    `status=${nestedAgain.json?.results?.[0]?.status}`,
  );

  const nestedRemoved = await runJson(['--config', nestedFile, '--uninstall']);
  const nestedAfter = fs.readFileSync(nestedFile, 'utf8');
  record(
    'yaml: uninstall removes only the nested entry',
    nestedRemoved.json?.results?.[0]?.status === 'removed' &&
      !nestedAfter.includes('mcp-mindplus') &&
      nestedAfter.includes('- id: tool-a') &&
      nestedAfter.includes('- id: tool-b') &&
      nestedAfter.includes('- insert:'),
    'siblings preserved',
  );

  // ---- Read-only surfaces ------------------------------------------------
  const printed = await run(['--print']);
  // JSON snippets escape backslashes, so normalise before comparing paths.
  const printedPlain = printed.stdout.replace(/\\\\/g, '\\');
  record(
    '--print emits all three snippets',
    printed.code === 0 &&
      printed.stdout.includes('mcpServers') &&
      printed.stdout.includes('"servers"') &&
      printed.stdout.includes('failOnStartupError') &&
      printedPlain.includes(entry),
    'snippets',
  );

  const listed = await runJson(['--list']);
  const ids = (listed.json?.detected ?? []).map((item) => item.id);
  record(
    '--list reports the client map',
    listed.code === 0 &&
      ids.includes('claude-desktop') &&
      ids.includes('cursor') &&
      ids.includes('vscode') &&
      ids.includes('workbuddy') &&
      listed.json?.detected?.every((item) => typeof item.file === 'string'),
    `${ids.length} targets`,
  );

  // ---- --server-args -----------------------------------------------------
  const shotDir = String.raw`C:\Users\someone\AppData\Local\mindplus-mcp\shots`;
  const visionFile = String.raw`C:\Users\someone\.workbuddy-ai\mindplus-vision.json`;

  const byString = await runJson([
    '--print',
    '--json',
    '--target',
    'workbuddy',
    '--server-args',
    `--shot-dir "${shotDir}" --vision-config "${visionFile}"`,
  ]);
  const stringArgs = byString.json?.snippets?.standard?.args ?? [];
  record(
    '--server-args: quoted string form keeps Windows paths intact',
    stringArgs.includes('--shot-dir') &&
      stringArgs.includes(shotDir) &&
      stringArgs.includes('--vision-config') &&
      stringArgs.includes(visionFile),
    JSON.stringify(stringArgs.slice(2)),
  );

  const byJson = await runJson([
    '--print',
    '--json',
    '--target',
    'workbuddy',
    '--server-args',
    JSON.stringify(['--shot-dir', shotDir, '--vision-config', visionFile]),
  ]);
  record(
    '--server-args: JSON array form matches the string form',
    JSON.stringify(byJson.json?.snippets?.standard?.args) === JSON.stringify(stringArgs),
    'identical argv',
  );

  const repeated = await runJson(['--print', '--json', '--target', 'workbuddy', '--server-args', '--a 1', '--server-args', '--b 2']);
  record(
    '--server-args: repeatable and appended after --transport stdio',
    JSON.stringify(repeated.json?.snippets?.standard?.args?.slice(1)) === '["--transport","stdio","--a","1","--b","2"]',
    JSON.stringify(repeated.json?.snippets?.standard?.args?.slice(1)),
  );

  const plain = await runJson(['--print', '--json', '--target', 'workbuddy']);
  record(
    '--server-args: absent by default',
    JSON.stringify(plain.json?.snippets?.standard?.args?.slice(1)) === '["--transport","stdio"]',
    JSON.stringify(plain.json?.snippets?.standard?.args?.slice(1)),
  );

  const badArgs = await run(['--print', '--server-args', '[not json']);
  record(
    '--server-args: malformed JSON fails cleanly',
    badArgs.code === 1 && /not valid JSON/.test(badArgs.stdout + badArgs.stderr),
    `exit=${badArgs.code}`,
  );

  const yamlWithArgs = await runJson(['--print', '--json', '--target', 'dsh:core-017', '--server-args', JSON.stringify(['--shot-dir', shotDir])]);
  const yamlSnippet = yamlWithArgs.json?.snippets?.dsh ?? '';
  record(
    '--server-args: reaches the DSH YAML snippet too',
    yamlSnippet.includes('--shot-dir') && yamlSnippet.replace(/\\\\/g, '\\').includes(shotDir),
    'yaml carries the extra arg',
  );

  const unknown = await run(['--target', 'not-a-client']);
  record(
    'unknown --target fails cleanly',
    unknown.code === 1 && /unknown target/.test(unknown.stdout),
    `exit=${unknown.code}`,
  );
} catch (error) {
  record('install harness', false, error.message);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  const failed = results.filter((item) => !item.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
