/**
 * Image toolkit for mindplus-mcp — pure JavaScript, no dependencies.
 *
 * Two jobs:
 *   1. Decode/encode PNG so screenshots can be cropped, downscaled and
 *      annotated before being handed to a vision model (node:zlib does the
 *      heavy lifting; the rest is the PNG spec).
 *   2. Provide the *local* half of the recognition framework — template
 *      matching and colour search — so automation still works with no model
 *      configured at all.
 *
 * Everything here is synchronous and allocation-light; a 2560x1440 screen is
 * about 14 MB as RGBA, which is fine to hold for a moment per call.
 */

import zlib from 'node:zlib';

export class ImageError extends Error {}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// PNG decoding
// ---------------------------------------------------------------------------

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo the per-scanline PNG filters, in place, on a raw sample buffer. */
function unfilter(raw, width, height, bitsPerPixel, bytesPerPixel) {
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const out = Buffer.alloc(rowBytes * height);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source];
    source += 1;
    const rowStart = y * rowBytes;
    const prevStart = rowStart - rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const value = raw[source + i];
      const left = i >= bytesPerPixel ? out[rowStart + i - bytesPerPixel] : 0;
      const up = y > 0 ? out[prevStart + i] : 0;
      const upLeft = y > 0 && i >= bytesPerPixel ? out[prevStart + i - bytesPerPixel] : 0;
      let result;
      switch (filter) {
        case 0:
          result = value;
          break;
        case 1:
          result = value + left;
          break;
        case 2:
          result = value + up;
          break;
        case 3:
          result = value + ((left + up) >> 1);
          break;
        case 4:
          result = value + paeth(left, up, upLeft);
          break;
        default:
          throw new ImageError(`unsupported PNG filter type ${filter} on row ${y}`);
      }
      out[rowStart + i] = result & 0xff;
    }
    source += rowBytes;
  }
  return out;
}

function readPixel(row, x, bitDepth, channels) {
  const values = new Array(channels);
  if (bitDepth === 8) {
    const base = x * channels;
    for (let c = 0; c < channels; c += 1) values[c] = row[base + c];
    return values;
  }
  if (bitDepth === 16) {
    // keep the high byte: screenshots never need 16-bit precision here
    const base = x * channels * 2;
    for (let c = 0; c < channels; c += 1) values[c] = row[base + c * 2];
    return values;
  }
  // bit depths 1, 2 and 4 pack several pixels per byte (greyscale / palette only)
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  const byte = row[Math.floor(x / perByte)];
  const shift = 8 - bitDepth * ((x % perByte) + 1);
  values[0] = (byte >> shift) & mask;
  for (let c = 1; c < channels; c += 1) values[c] = 0;
  return values;
}

/**
 * Decode a PNG buffer into { width, height, data } where data is RGBA8.
 * Adam7 interlacing is rejected rather than silently mangled.
 */
export function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ImageError('not a PNG file (bad signature)');
  }
  let offset = 8;
  let header = null;
  let palette = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (!header) throw new ImageError('PNG has no IHDR chunk');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (interlace !== 0) throw new ImageError('interlaced (Adam7) PNG is not supported');
  const channels = CHANNELS[colorType];
  if (!channels) throw new ImageError(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new ImageError('palette PNG without a PLTE chunk');
  const bitsPerPixel = channels * bitDepth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const expected = Math.ceil((width * bitsPerPixel) / 8) * height + height;
  if (raw.length < expected) throw new ImageError('PNG image data is truncated');
  const samples = unfilter(raw, width, height, bitsPerPixel, bytesPerPixel);

  const data = Buffer.alloc(width * height * 4);
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const maxValue = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y += 1) {
    const row = samples.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x += 1) {
      const values = readPixel(row, x, bitDepth, channels);
      const target = (y * width + x) * 4;
      if (colorType === 0 || colorType === 4) {
        const grey = bitDepth === 8 ? values[0] : Math.round((values[0] / maxValue) * 255);
        data[target] = grey;
        data[target + 1] = grey;
        data[target + 2] = grey;
        data[target + 3] = colorType === 4 ? values[1] : 255;
      } else if (colorType === 2 || colorType === 6) {
        data[target] = values[0];
        data[target + 1] = values[1];
        data[target + 2] = values[2];
        data[target + 3] = colorType === 6 ? values[3] : 255;
      } else {
        const entry = values[0] * 3;
        data[target] = palette[entry];
        data[target + 1] = palette[entry + 1];
        data[target + 2] = palette[entry + 2];
        data[target + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typeAndBody = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndBody), 0);
  return Buffer.concat([length, typeAndBody, crc]);
}

/** Encode an RGBA image back to PNG (colour type 6, filter 0). */
export function encodePng({ width, height, data }) {
  if (!width || !height) throw new ImageError('cannot encode a zero-sized image');
  if (data.length < width * height * 4) throw new ImageError('RGBA buffer is smaller than width*height*4');
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    data.copy
      ? data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
      : Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// basic operations
// ---------------------------------------------------------------------------

export function getPixel(image, x, y) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const index = (y * image.width + x) * 4;
  return { r: image.data[index], g: image.data[index + 1], b: image.data[index + 2], a: image.data[index + 3] };
}

export function setPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const index = (y * image.width + x) * 4;
  image.data[index] = color.r;
  image.data[index + 1] = color.g;
  image.data[index + 2] = color.b;
  image.data[index + 3] = color.a ?? 255;
}

export function crop(image, x, y, width, height) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const w = Math.min(Math.floor(width), image.width - left);
  const h = Math.min(Math.floor(height), image.height - top);
  if (w <= 0 || h <= 0) throw new ImageError('crop region lies outside the image');
  const data = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    image.data.copy(data, row * w * 4, ((top + row) * image.width + left) * 4, ((top + row) * image.width + left + w) * 4);
  }
  return { width: w, height: h, data };
}

/** Box-filter resize. `width`/`height` are the *target* size. */
export function resize(image, width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === image.width && h === image.height) return { width: w, height: h, data: Buffer.from(image.data) };
  const data = Buffer.alloc(w * h * 4);
  const scaleX = image.width / w;
  const scaleY = image.height / h;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        let index = (sy * image.width + x0) * 4;
        for (let sx = x0; sx < x1; sx += 1) {
          r += image.data[index];
          g += image.data[index + 1];
          b += image.data[index + 2];
          a += image.data[index + 3];
          count += 1;
          index += 4;
        }
      }
      const target = (y * w + x) * 4;
      data[target] = Math.round(r / count);
      data[target + 1] = Math.round(g / count);
      data[target + 2] = Math.round(b / count);
      data[target + 3] = Math.round(a / count);
    }
  }
  return { width: w, height: h, data };
}

/** Scale an image down so its width does not exceed `maxWidth` (never upscales). */
export function fitWidth(image, maxWidth) {
  if (!maxWidth || image.width <= maxWidth) return { image, scale: 1 };
  const scale = maxWidth / image.width;
  return { image: resize(image, Math.round(image.width * scale), Math.round(image.height * scale)), scale };
}

// ---------------------------------------------------------------------------
// annotation (so a human can see what the model picked)
// ---------------------------------------------------------------------------

export function parseColor(value, fallback = { r: 255, g: 0, b: 0 }) {
  if (!value) return fallback;
  if (typeof value === 'object' && value.r !== undefined) return { r: value.r, g: value.g, b: value.b, a: value.a ?? 255 };
  const text = String(value).trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(text)) {
    return { r: parseInt(text.slice(0, 2), 16), g: parseInt(text.slice(2, 4), 16), b: parseInt(text.slice(4, 6), 16), a: 255 };
  }
  if (/^[0-9a-f]{3}$/i.test(text)) {
    return {
      r: parseInt(text[0] + text[0], 16),
      g: parseInt(text[1] + text[1], 16),
      b: parseInt(text[2] + text[2], 16),
      a: 255,
    };
  }
  throw new ImageError(`cannot parse colour "${value}" (use #rrggbb)`);
}

export function drawRect(image, x, y, width, height, color, thickness = 2) {
  const c = parseColor(color);
  for (let t = 0; t < thickness; t += 1) {
    for (let i = 0; i < width; i += 1) {
      setPixel(image, x + i, y + t, c);
      setPixel(image, x + i, y + height - 1 - t, c);
    }
    for (let i = 0; i < height; i += 1) {
      setPixel(image, x + t, y + i, c);
      setPixel(image, x + width - 1 - t, y + i, c);
    }
  }
  return image;
}

export function drawCross(image, x, y, size, color, thickness = 2) {
  const c = parseColor(color);
  for (let t = 0; t < thickness; t += 1) {
    for (let i = -size; i <= size; i += 1) {
      setPixel(image, x + i, y + t, c);
      setPixel(image, x + t, y + i, c);
    }
  }
  return image;
}

/** Return a copy of the image with a marker drawn at (x, y) inside a box. */
export function annotate(image, { x, y, box, color = '#ff0000', size = 14 } = {}) {
  const copy = { width: image.width, height: image.height, data: Buffer.from(image.data) };
  if (box) drawRect(copy, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height), color, 2);
  if (x !== undefined && y !== undefined) drawCross(copy, Math.round(x), Math.round(y), size, color, 2);
  return copy;
}

// ---------------------------------------------------------------------------
// recognition primitives
// ---------------------------------------------------------------------------

/**
 * Find `template` inside `haystack` by exhaustive search with early exit.
 *
 * Returns candidates sorted best-first, with overlapping hits suppressed so a
 * single button does not fill the list with near-identical offsets.
 */
export function templateMatch(haystack, template, options = {}) {
  const { region, minScore = 0.9, maxResults = 5, stride, tolerance } = options;
  const area = region
    ? {
        x: Math.max(0, Math.floor(region.x)),
        y: Math.max(0, Math.floor(region.y)),
        width: Math.min(Math.floor(region.width), haystack.width - Math.max(0, Math.floor(region.x))),
        height: Math.min(Math.floor(region.height), haystack.height - Math.max(0, Math.floor(region.y))),
      }
    : { x: 0, y: 0, width: haystack.width, height: haystack.height };
  const tw = template.width;
  const th = template.height;
  if (tw > area.width || th > area.height) {
    return { found: false, reason: 'template is larger than the search region', candidates: [] };
  }
  const maxX = area.x + area.width - tw;
  const maxY = area.y + area.height - th;
  const step = Math.max(1, stride ?? (tw >= 24 || th >= 24 ? 2 : 1));
  const pixelCount = tw * th;
  // Worst acceptable total absolute difference across RGB.
  const budget = tolerance !== undefined ? tolerance * 255 * 3 * pixelCount : (1 - minScore) * 255 * 3 * pixelCount;

  const hits = [];
  for (let y = area.y; y <= maxY; y += step) {
    for (let x = area.x; x <= maxX; x += step) {
      let sad = 0;
      let aborted = false;
      for (let ty = 0; ty < th && !aborted; ty += 1) {
        let hIndex = ((y + ty) * haystack.width + x) * 4;
        let tIndex = ty * tw * 4;
        for (let tx = 0; tx < tw; tx += 1) {
          sad += Math.abs(haystack.data[hIndex] - template.data[tIndex]);
          sad += Math.abs(haystack.data[hIndex + 1] - template.data[tIndex + 1]);
          sad += Math.abs(haystack.data[hIndex + 2] - template.data[tIndex + 2]);
          if (sad > budget) {
            aborted = true;
            break;
          }
          hIndex += 4;
          tIndex += 4;
        }
      }
      if (!aborted) {
        const score = 1 - sad / (255 * 3 * pixelCount);
        hits.push({ x, y, width: tw, height: th, score: Math.round(score * 1e6) / 1e6 });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const hit of hits) {
    const overlaps = kept.some(
      (other) =>
        Math.abs(other.x - hit.x) < tw / 2 && Math.abs(other.y - hit.y) < th / 2,
    );
    if (!overlaps) kept.push(hit);
    if (kept.length >= maxResults) break;
  }
  if (!kept.length) {
    return { found: false, reason: `no match scored at or above ${(1 - budget / (255 * 3 * pixelCount)).toFixed(3)}`, candidates: [] };
  }
  return {
    found: true,
    best: kept[0],
    center: { x: Math.round(kept[0].x + tw / 2), y: Math.round(kept[0].y + th / 2) },
    candidates: kept,
    searched: { x: area.x, y: area.y, width: area.width, height: area.height, stride: step },
  };
}

/**
 * Locate pixels matching a colour within `tolerance` (per channel, 0-255).
 * Returns the bounding box, centroid and cluster count.
 */
export function findColor(image, { color, tolerance = 16, region } = {}) {
  const target = parseColor(color);
  const area = region
    ? {
        x: Math.max(0, Math.floor(region.x)),
        y: Math.max(0, Math.floor(region.y)),
        width: Math.min(Math.floor(region.width), image.width - Math.max(0, Math.floor(region.x))),
        height: Math.min(Math.floor(region.height), image.height - Math.max(0, Math.floor(region.y))),
      }
    : { x: 0, y: 0, width: image.width, height: image.height };
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const samples = [];
  for (let y = area.y; y < area.y + area.height; y += 1) {
    let index = (y * image.width + area.x) * 4;
    for (let x = area.x; x < area.x + area.width; x += 1) {
      if (
        Math.abs(image.data[index] - target.r) <= tolerance &&
        Math.abs(image.data[index + 1] - target.g) <= tolerance &&
        Math.abs(image.data[index + 2] - target.b) <= tolerance
      ) {
        count += 1;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (samples.length < 200) samples.push({ x, y });
      }
      index += 4;
    }
  }
  if (!count) return { found: false, color: target, tolerance };
  return {
    found: true,
    color: target,
    tolerance,
    count,
    center: { x: Math.round(sumX / count), y: Math.round(sumY / count) },
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    samples,
  };
}

/** Pixel-level difference between two same-sized images (change detection). */
export function diffImages(before, after, { tolerance = 12 } = {}) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new ImageError('diffImages needs two images of the same size');
  }
  let changed = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < before.height; y += 1) {
    let index = y * before.width * 4;
    for (let x = 0; x < before.width; x += 1) {
      const delta =
        Math.abs(before.data[index] - after.data[index]) +
        Math.abs(before.data[index + 1] - after.data[index + 1]) +
        Math.abs(before.data[index + 2] - after.data[index + 2]);
      if (delta > tolerance * 3) {
        changed += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      index += 4;
    }
  }
  const total = before.width * before.height;
  return {
    changedPixels: changed,
    totalPixels: total,
    ratio: Math.round((changed / total) * 1e6) / 1e6,
    bounds: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}
