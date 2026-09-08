const test = require('node:test');
const assert = require('node:assert/strict');
const { WIDGET_ICON_PATH, WIDGET_ICON_SIZE, widgetIconIcoBuffer, widgetIconPngBuffer, widgetIconPngDataUrl, widgetIconSvg, createWidgetNativeImage } = require('../src/widget-icon');

test('uses one shared 2x2 rounded-square mark for manager and tray', () => {
  assert.match(WIDGET_ICON_PATH, /widget-icon\.svg$/);
  const svg = widgetIconSvg();
  assert.equal((svg.match(/<rect\b/g) || []).length, 4);
  assert.equal((svg.match(/fill="#176bd8"/g) || []).length, 4);
  assert.match(svg, /viewBox="0 0 32 32"/);
  const buffer = widgetIconPngBuffer();
  assert.deepEqual(buffer.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(buffer.readUInt32BE(16), WIDGET_ICON_SIZE);
  assert.equal(buffer.readUInt32BE(20), WIDGET_ICON_SIZE);
  assert.match(widgetIconPngDataUrl(), /^data:image\/png;base64,/);
});

test('creates native image from the shared PNG buffer', () => {
  let received;
  const image = createWidgetNativeImage({ createFromBuffer: value => { received = value; return 'native-image'; } });
  assert.equal(image, 'native-image');
  assert.deepEqual(received.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(received.readUInt32BE(16), WIDGET_ICON_SIZE);
  assert.equal(received.readUInt32BE(20), WIDGET_ICON_SIZE);
});

test('builds a multi-size ICO from the shared icon pixels', () => {
  const ico = widgetIconIcoBuffer();
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  for (let index = 0; index < 7; index += 1) {
    const entry = 6 + index * 16;
    const imageOffset = ico.readUInt32LE(entry + 12);
    assert.ok(ico.readUInt32LE(entry + 8) > 0);
    assert.ok(imageOffset + ico.readUInt32LE(entry + 8) <= ico.length);
    assert.deepEqual(ico.subarray(imageOffset, imageOffset + 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
});
