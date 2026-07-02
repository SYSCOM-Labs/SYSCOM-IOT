import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptDecoderScriptForSyscom } from '../src/utils/adaptDecoderScript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const rawPath = process.argv[2] || path.join(__dirname, 'uc701-decoder.raw.js');

const raw = fs.readFileSync(rawPath, 'utf8');
const { script: body } = adaptDecoderScriptForSyscom(raw);
const outPath = path.join(root, 'src/constants/uc701DecoderScript.js');
fs.writeFileSync(outPath, `export const UC701_DECODER_SCRIPT = ${JSON.stringify(body)};\n`, 'utf8');
console.log('Wrote', outPath, body.length, 'chars');
