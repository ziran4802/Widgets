const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const WIDGET_ICON_PATH = path.join(__dirname, 'widget-icon.svg');
const WIDGET_ICON_SIZE = 64;
const WIDGET_ICON_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
let cachedSvg;
let cachedPng;
let cachedIco;

function widgetIconSvg() {
  if (!cachedSvg) cachedSvg = fs.readFileSync(WIDGET_ICON_PATH, 'utf8');
  return cachedSvg;
}

function crc32(value) {
  let result = 0xffffffff;
  for (const byte of value) {
    let current = (result ^ byte) & 255;
    for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
    result = current ^ (result >>> 8);
  }
  return (result ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function drawRoundedSquare(pixels, size, x0, y0, width, height, radius) {
  for (let y = y0; y < y0 + height; y += 1) for (let x = x0; x < x0 + width; x += 1) {
    let inside = (x >= x0 + radius && x < x0 + width - radius) || (y >= y0 + radius && y < y0 + height - radius);
    if (!inside) {
      const cx = x < x0 + radius ? x0 + radius : x0 + width - radius - 1;
      const cy = y < y0 + radius ? y0 + radius : y0 + height - radius - 1;
      inside = (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius;
    }
    if (!inside) continue;
    const index = (y * size + x) * 4;
    pixels[index] = 23;
    pixels[index + 1] = 107;
    pixels[index + 2] = 216;
    pixels[index + 3] = 255;
  }
}

function createPngBuffer(size) {
  const margin = Math.max(1, Math.round(size * 4 / WIDGET_ICON_SIZE));
  const square = Math.max(1, Math.round(size * 24 / WIDGET_ICON_SIZE));
  const radius = Math.max(1, Math.round(size * 6 / WIDGET_ICON_SIZE));
  const gap = Math.max(1, Math.round(size * 8 / WIDGET_ICON_SIZE));
  const pixels = Buffer.alloc(size * size * 4);
  drawRoundedSquare(pixels, size, margin, margin, square, square, radius);
  drawRoundedSquare(pixels, size, margin + square + gap, margin, square, square, radius);
  drawRoundedSquare(pixels, size, margin, margin + square + gap, square, square, radius);
  drawRoundedSquare(pixels, size, margin + square + gap, margin + square + gap, square, square, radius);

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0;
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function widgetIconPngBuffer() {
  if (cachedPng) return cachedPng;
  cachedPng = createPngBuffer(WIDGET_ICON_SIZE);
  return cachedPng;
}

function widgetIconIcoBuffer() {
  if (cachedIco) return cachedIco;
  const images = WIDGET_ICON_ICO_SIZES.map(size => ({ size, data: createPngBuffer(size) }));
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  cachedIco = Buffer.concat([directory, ...images.map(image => image.data)]);
  return cachedIco;
}

function widgetIconPngDataUrl() {
  return `data:image/png;base64,${widgetIconPngBuffer().toString('base64')}`;
}

function createWidgetNativeImage(nativeImage) {
  if (!nativeImage || typeof nativeImage.createFromBuffer !== 'function') throw new TypeError('nativeImage.createFromBuffer is required');
  const image = nativeImage.createFromBuffer(widgetIconPngBuffer());
  if (typeof image?.isEmpty === 'function' && image.isEmpty()) throw new Error('Widget PNG native image is empty');
  return image;
}

module.exports = { WIDGET_ICON_PATH, WIDGET_ICON_SIZE, widgetIconSvg, widgetIconPngBuffer, widgetIconIcoBuffer, widgetIconPngDataUrl, createWidgetNativeImage };
