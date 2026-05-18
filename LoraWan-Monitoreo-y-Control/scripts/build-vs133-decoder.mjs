import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adaptDecoderScriptForSyscom } from '../src/utils/adaptDecoderScript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const rawPath =
  process.argv[2] ||
  path.join(
    process.env.USERPROFILE || '',
    '.cursor/projects/c-Users-E-EC1-2832-Documents-GitHub-SYSCOM-IOT/agent-tools/90d58c04-9a56-43bb-b46b-67d1625f823d.txt'
  );

const raw = fs.readFileSync(rawPath, 'utf8');
const { script: body } = adaptDecoderScriptForSyscom(raw);

const out = body;
const jsOut = `export const VS133_DECODER_SCRIPT = ${JSON.stringify(out)};\n`;
const outPath = path.join(root, 'src/constants/vs133DecoderScript.js');
fs.writeFileSync(outPath, jsOut, 'utf8');

const cjsOut = `'use strict';\nmodule.exports = { DECODER_SCRIPT: ${JSON.stringify(out)} };\n`;
fs.writeFileSync(path.join(root, 'server/milesight-vs133-decoder.cjs'), cjsOut, 'utf8');
console.log('Wrote', outPath, 'and server/milesight-vs133-decoder.cjs', out.length, 'chars');
