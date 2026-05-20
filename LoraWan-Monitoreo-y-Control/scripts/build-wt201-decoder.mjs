import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptDecoderScriptForSyscom } from '../src/utils/adaptDecoderScript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const rawPath =
  process.argv[2] ||
  'https://raw.githubusercontent.com/Milesight-IoT/SensorDecoders/main/wt-series/wt201/wt201-decoder.js';

let raw;
if (/^https?:\/\//i.test(rawPath)) {
  raw = await (await fetch(rawPath)).text();
} else {
  raw = fs.readFileSync(rawPath, 'utf8');
}

const { script: body } = adaptDecoderScriptForSyscom(raw);
const jsOut = `export const WT201_DECODER_SCRIPT = ${JSON.stringify(body)};\n`;
const outPath = path.join(root, 'src/constants/wt201DecoderScript.js');
fs.writeFileSync(outPath, jsOut, 'utf8');
console.log('Wrote', outPath, body.length, 'chars');
