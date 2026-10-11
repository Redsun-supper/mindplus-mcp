/**
 * High-level GUI automation flows for mindplus-mcp.
 *
 * tools.js stays declarative: it describes schemas and delegates here. This
 * module owns the actual loop — grab the screen, ask the recognition layer
 * where to act, convert coordinates back to screen space, inject input, and
 * record enough evidence (annotated PNGs, a step log) that a human can audit
 * what happened.
 *
 * Coordinate model
 * ----------------
 * A capture is a rectangle of the desktop at `region.x/region.y`. Before going
 * to a model it may be downscaled to `scale` (sentWidth / regionWidth). Points
 * coming back are in the *sent image* space, so:
 *
 *     screenX = region.x + imageX / scale
 *
 * That is exactly what toScreenPoint() in vision.js does.
 */

import fs from 'node:fs';
import path from 'node:path';

import { decodePng, encodePng, annotate, fitWidth, crop, getPixel, templateMatch, findColor } from './image.js';
import { toScreenPoint, toScreenBox } from './vision.js';

export class AutomationError extends Error {}

export const DEFAULT_ACTIONS = [
  'click',
  'double_click',
  'right_click',
  'move',
  'drag',
  'scroll',
  'type',
  'key',
  'wait',
  'done',
  'fail',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Work out what to capture from tool arguments: an explicit window, an explicit
 * region, or (returning null) the whole virtual desktop.
 */
export async function resolveArea(gui, { window: windowQuery, region } = {}) {
  if (windowQuery !== undefined && windowQuery !== null && windowQuery !== '') {
    const found = await gui.findWindow(windowQuery);
    if (!found) throw new AutomationError(`no visible window matches "${windowQuery}"`);
    const rect = await gui.windowRect(found.handle);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, handle: found.handle, window: found };
  }
  if (region) {
    const x = Math.round(region.x ?? 0);
    const y = Math.round(region.y ?? 0);
    const width = Math.round(region.width ?? 0);
    const height = Math.round(region.height ?? 0);
    if (width <= 0 || height <= 0) throw new AutomationError('region needs a positive width and height');
    return { x, y, width, height, handle: null, window: null };
  }
  return null;
}

/**
 * Capture the desktop (or a region / a window) and decode it, downscaling for
 * the model when asked. Returns everything downstream code needs.
 */
export async function grabScreen(gui, options = {}) {
  const { region, window: windowQuery, maxWidth, format = 'png', quality = 90, activateWindow = false } = options;

  let x;
  let y;
  let width;
  let height;
  let handle = null;
  let windowInfo = null;

  if (windowQuery !== undefined && windowQuery !== null && windowQuery !== '') {
    windowInfo = await gui.findWindow(windowQuery);
    if (!windowInfo) throw new AutomationError(`no visible window matches "${windowQuery}"`);
    handle = windowInfo.handle;
    if (activateWindow) await gui.windowActivate(handle, { waitMs: 250 });
    const bounds = await gui.windowRect(handle);
    x = bounds.x;
    y = bounds.y;
    width = bounds.width;
    height = bounds.height;
  } else if (region) {
    x = Math.round(region.x ?? 0);
    y = Math.round(region.y ?? 0);
    width = Math.round(region.width ?? 0);
    height = Math.round(region.height ?? 0);
  } else {
    const info = await gui.screenInfo();
    x = info.virtualDesktop.x;
    y = info.virtualDesktop.y;
    width = info.virtualDesktop.width;
    height = info.virtualDesktop.height;
  }

  if (!width || !height) throw new AutomationError('could not determine a capture area');

  const capture = await gui.capture({ x, y, width, height, format, quality, handle });
  const buffer = fs.readFileSync(capture.path);
  const image = decodePng(buffer);
  const fitted = maxWidth ? fitWidth(image, maxWidth) : { image, scale: 1 };

  return {
    capture,
    file: capture.path,
    buffer,
    image: fitted.image,
    full: image,
    scale: fitted.scale,
    region: { x, y, width, height },
    transform: { offsetX: x, offsetY: y, scale: fitted.scale },
    window: windowInfo,
  };
}

function imageBase64Of(image) {
  return encodePng(image).toString('base64');
}

/**
 * Screenshot -> model -> screen coordinates.
 *
 * Returns both the raw model point (in image space) and the mapped screen point,
 * plus an annotated PNG so the caller can see what the model chose.
 */
export async function locateOnScreen({ gui, vision, instruction, region, window, maxWidth, mode = 'point', extra, annotate: wantAnnotated = true, shotDir }) {
  const grab = await grabScreen(gui, { region, window, maxWidth });
  if (!vision.available) {
    throw new AutomationError(
      'no vision provider is configured, so "locate by description" is unavailable — ' +
        'configure MINDLINK_VISION_PROVIDER, or use image_find / pixel_find which need no model',
    );
  }
  const result = await vision.locate({
    instruction,
    imageBase64: imageBase64Of(grab.image),
    width: grab.image.width,
    height: grab.image.height,
    mode,
    extra,
  });

  const out = {
    provider: vision.description,
    region: grab.region,
    scale: grab.scale,
    imageSize: { width: grab.image.width, height: grab.image.height },
    screenshot: grab.file,
    mode,
    instruction,
  };

  if (mode === 'list') {
    out.found = result.found;
    out.elements = (result.elements ?? []).map((element) => ({
      label: element.label,
      confidence: element.confidence,
      imagePoint: { x: element.x, y: element.y },
      screenPoint: toScreenPoint({ x: element.x, y: element.y }, grab.transform),
    }));
    out.reasoning = result.reasoning ?? null;
    return out;
  }

  out.found = result.found;
  out.label = result.label ?? null;
  out.confidence = result.confidence ?? null;
  out.reasoning = result.reasoning ?? null;
  out.alternatives = (result.alternatives ?? []).map((item) => ({
    label: item.label,
    confidence: item.confidence,
    screenPoint: toScreenPoint({ x: item.x, y: item.y }, grab.transform),
  }));

  if (!result.found) {
    out.error = result.error ?? 'the model did not find the target';
    out.screenshot = grab.file;
    return out;
  }

  out.imagePoint = { x: result.x, y: result.y };
  out.screenPoint = toScreenPoint({ x: result.x, y: result.y }, grab.transform);
  const box = toScreenBox({ x: result.x, y: result.y, width: result.width, height: result.height }, grab.transform);
  if (box) out.screenBox = box;

  if (wantAnnotated) {
    const marker = annotate(grab.full, {
      x: result.x / grab.scale,
      y: result.y / grab.scale,
      box:
        result.width && result.height
          ? { x: (result.x - result.width / 2) / grab.scale, y: (result.y - result.height / 2) / grab.scale, width: result.width / grab.scale, height: result.height / grab.scale }
          : undefined,
    });
    const target = path.join(shotDir ?? path.dirname(grab.file), `located-${path.basename(grab.file)}`);
    fs.writeFileSync(target, encodePng(marker));
    out.annotated = target;
  }
  return out;
}

/** Run a single action from the automation vocabulary. */
export async function performAction(gui, action, transform, { dryRun = false, settleMs = 0 } = {}) {
  const map = (point) => toScreenPoint(point, transform);
  const record = { action: action.action, dryRun };
  switch (action.action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      if (action.x === null || action.y === null) throw new AutomationError(`${action.action} needs x and y`);
      const point = map({ x: action.x, y: action.y });
      const button = action.action === 'right_click' ? 'right' : 'left';
      const count = action.action === 'double_click' ? 2 : 1;
      Object.assign(record, { button, count, screenPoint: point });
      await gui.mouseClick(point.x, point.y, { button, count, dryRun });
      break;
    }
    case 'move': {
      const point = map({ x: action.x, y: action.y });
      record.screenPoint = point;
      await gui.mouseMove(point.x, point.y, { durationMs: 150, dryRun });
      break;
    }
    case 'drag': {
      if ([action.x, action.y, action.toX, action.toY].some((v) => v === null || v === undefined)) {
        throw new AutomationError('drag needs x, y, toX and toY');
      }
      const from = map({ x: action.x, y: action.y });
      const to = map({ x: action.toX, y: action.toY });
      record.from = from;
      record.to = to;
      await gui.mouseDrag(from.x, from.y, to.x, to.y, { durationMs: 350, dryRun });
      break;
    }
    case 'scroll': {
      const point = map({ x: action.x ?? 0, y: action.y ?? 0 });
      record.screenPoint = point;
      record.deltaV = action.delta ?? 3;
      await gui.mouseScroll(point.x, point.y, { deltaV: record.deltaV, dryRun });
      break;
    }
    case 'type': {
      record.text = action.text ?? '';
      await gui.keyType(record.text, { delayMs: 12, dryRun });
      break;
    }
    case 'key': {
      record.keys = action.keys ?? '';
      await gui.keyPress(record.keys, { dryRun });
      break;
    }
    case 'wait': {
      record.ms = Math.min(action.ms ?? 500, 30000);
      if (!dryRun) await sleep(record.ms);
      break;
    }
    case 'done':
    case 'fail':
      record.reason = action.reason ?? null;
      break;
    default:
      throw new AutomationError(`unknown action "${action.action}"`);
  }
  if (!dryRun && settleMs > 0) await sleep(settleMs);
  return record;
}

/**
 * The step-wise automation loop: look, decide, act, repeat.
 *
 * Bounded on purpose — a vision loop with no ceiling is how a machine ends up
 * clicking forever. `dryRun` walks the whole loop without injecting any input.
 */
export async function runVisionLoop({
  gui,
  vision,
  goal,
  region,
  window,
  maxWidth,
  maxSteps = 8,
  settleMs = 600,
  allowed = DEFAULT_ACTIONS,
  dryRun = false,
  shotDir,
  onStep,
}) {
  if (!vision.available) {
    throw new AutomationError('vision_act needs a configured vision provider (MINDLINK_VISION_PROVIDER)');
  }
  const history = [];
  const steps = [];
  let outcome = 'max-steps';

  for (let step = 1; step <= maxSteps; step += 1) {
    const grab = await grabScreen(gui, { region, window, maxWidth });
    const action = await vision.nextAction({
      goal,
      history,
      width: grab.image.width,
      height: grab.image.height,
      allowed,
      step,
      maxSteps,
      imageBase64: imageBase64Of(grab.image),
    });

    const entry = { step, screenshot: grab.file, decision: action.action, reason: action.reason ?? null };

    if (action.action === 'done' || action.action === 'fail') {
      entry.skipped = true;
      steps.push(entry);
      outcome = action.action === 'done' ? 'done' : 'failed';
      if (onStep) onStep(entry);
      break;
    }
    if (!allowed.includes(action.action)) {
      entry.skipped = true;
      entry.note = `action "${action.action}" is not in the allowed list`;
      steps.push(entry);
      outcome = 'blocked';
      if (onStep) onStep(entry);
      break;
    }

    try {
      entry.executed = await performAction(gui, action, grab.transform, { dryRun, settleMs });
    } catch (error) {
      entry.error = error.message;
      steps.push(entry);
      outcome = 'error';
      if (onStep) onStep(entry);
      break;
    }

    if (dryRun) {
      entry.note = 'dry run: input was not injected, stopping after the first planned action';
      steps.push(entry);
      outcome = 'dry-run';
      if (onStep) onStep(entry);
      break;
    }

    const summary = describeAction(action, entry.executed);
    history.push(`step ${step}: ${summary}`);
    steps.push(entry);
    if (onStep) onStep(entry);
  }

  return { goal, outcome, steps, history, dryRun, maxSteps };
}

function describeAction(action, executed) {
  const point = executed?.screenPoint ? ` at (${executed.screenPoint.x},${executed.screenPoint.y})` : '';
  switch (action.action) {
    case 'click':
    case 'double_click':
    case 'right_click':
      return `${action.action}${point}`;
    case 'type':
      return `typed ${JSON.stringify(action.text ?? '')}`;
    case 'key':
      return `pressed ${action.keys}`;
    case 'drag':
      return `dragged ${JSON.stringify(executed?.from)} -> ${JSON.stringify(executed?.to)}`;
    case 'scroll':
      return `scrolled ${executed?.deltaV ?? 0} notches${point}`;
    case 'move':
      return `moved to${point}`;
    case 'wait':
      return `waited ${executed?.ms ?? 0}ms`;
    default:
      return action.action;
  }
}

/**
 * Get the image the local matchers should search: either a fresh screenshot
 * (region / window / whole desktop) or a PNG that was captured earlier.
 */
async function loadSearchImage(gui, { source, sourceOrigin, region, window, maxWidth }) {
  if (source) {
    if (!fs.existsSync(source)) throw new AutomationError(`source image not found: ${source}`);
    const full = decodePng(fs.readFileSync(source));
    const fitted = maxWidth ? fitWidth(full, maxWidth) : { image: full, scale: 1 };
    const originX = Math.round(sourceOrigin?.x ?? 0);
    const originY = Math.round(sourceOrigin?.y ?? 0);
    return {
      image: fitted.image,
      full,
      scale: fitted.scale,
      screenshot: source,
      region: { x: originX, y: originY, width: full.width, height: full.height },
      transform: { offsetX: originX, offsetY: originY, scale: fitted.scale },
    };
  }
  const grab = await grabScreen(gui, { region, window, maxWidth });
  return {
    image: grab.image,
    full: grab.full,
    scale: grab.scale,
    screenshot: grab.file,
    region: grab.region,
    transform: grab.transform,
  };
}

/**
 * Local template search: find a previously saved PNG inside a fresh screenshot
 * (or inside another saved PNG when `source` is given).
 * This is the no-model path and is usually far more precise than a VLM.
 */
export async function findImageOnScreen({
  gui,
  templatePath,
  source,
  sourceOrigin,
  region,
  window,
  searchRegion,
  minScore,
  maxWidth,
  stride,
  maxResults = 5,
}) {
  if (!fs.existsSync(templatePath)) throw new AutomationError(`template image not found: ${templatePath}`);
  const template = decodePng(fs.readFileSync(templatePath));
  const target = await loadSearchImage(gui, { source, sourceOrigin, region, window, maxWidth });
  const search = templateMatch(target.image, template, { minScore, stride, maxResults, region: searchRegion });
  if (!search.found) {
    return { found: false, reason: search.reason, screenshot: target.screenshot, region: target.region, searched: search.searched };
  }
  return {
    found: true,
    score: search.best.score,
    screenPoint: toScreenPoint(search.center, target.transform),
    screenBox: {
      x: Math.round(target.region.x + search.best.x / target.scale),
      y: Math.round(target.region.y + search.best.y / target.scale),
      width: Math.round(search.best.width / target.scale),
      height: Math.round(search.best.height / target.scale),
    },
    imagePoint: search.center,
    candidates: search.candidates.map((candidate) => ({
      score: candidate.score,
      screenPoint: toScreenPoint({ x: candidate.x + candidate.width / 2, y: candidate.y + candidate.height / 2 }, target.transform),
    })),
    screenshot: target.screenshot,
    region: target.region,
    scale: target.scale,
    searched: search.searched,
  };
}

/** Local colour search on a fresh screenshot (or on a saved PNG). */
export async function findColorOnScreen({ gui, color, tolerance, source, sourceOrigin, region, window }) {
  const target = await loadSearchImage(gui, { source, sourceOrigin, region, window });
  const result = findColor(target.image, { color, tolerance });
  if (!result.found) return { found: false, color, tolerance, screenshot: target.screenshot, region: target.region };
  return {
    found: true,
    color: result.color,
    tolerance: result.tolerance,
    count: result.count,
    screenPoint: toScreenPoint(result.center, target.transform),
    screenBox: {
      x: Math.round(target.region.x + result.bounds.x / target.scale),
      y: Math.round(target.region.y + result.bounds.y / target.scale),
      width: Math.round(result.bounds.width / target.scale),
      height: Math.round(result.bounds.height / target.scale),
    },
    screenshot: target.screenshot,
    region: target.region,
  };
}

/** Save a capture for later use as a template; returns the file path. */
export function saveTemplate(image, shotDir, name = 'template') {
  fs.mkdirSync(shotDir, { recursive: true });
  const file = path.join(shotDir, `${name}-${Date.now()}.png`);
  fs.writeFileSync(file, encodePng(image));
  return file;
}

export { crop, getPixel };
