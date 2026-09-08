const fs = require('node:fs');
const path = require('node:path');
const { widgetIconIcoBuffer } = require('../src/widget-icon');

const outputPath = process.argv[2];
if (!outputPath) throw new Error('output path is required');
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, widgetIconIcoBuffer());
