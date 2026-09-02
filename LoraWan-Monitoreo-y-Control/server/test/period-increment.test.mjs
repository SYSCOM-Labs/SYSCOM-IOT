import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPeriodIncrementPoints,
  isLikelyCumulativeCounterFieldKey,
  streamSeriesUsesPeriodIncrement,
} from '../../src/components/dashboard/periodIncrementUtils.js';

test('total_in / total_out se tratan como contador acumulativo', () => {
  assert.equal(isLikelyCumulativeCounterFieldKey('total_in'), true);
  assert.equal(isLikelyCumulativeCounterFieldKey('total_out'), true);
  assert.equal(isLikelyCumulativeCounterFieldKey('temperature'), false);
  assert.equal(isLikelyCumulativeCounterFieldKey('period_in'), false);
  assert.equal(streamSeriesUsesPeriodIncrement({ fieldKey: 'total_in', valueMode: 'absolute' }), true);
  assert.equal(streamSeriesUsesPeriodIncrement({ fieldKey: 'temperature', valueMode: 'absolute' }), false);
  assert.equal(streamSeriesUsesPeriodIncrement({ fieldKey: 'temperature', valueMode: 'delta' }), true);
});

test('el incremento del periodo coincide con último − primero (sin reinicio)', () => {
  const pts = [
    { ts: 1, val: 195294 },
    { ts: 2, val: 195400 },
    { ts: 3, val: 195825 },
  ];
  const inc = applyPeriodIncrementPoints(pts);
  assert.equal(inc[0].val, 0);
  assert.equal(inc[1].val, 106);
  assert.equal(inc[inc.length - 1].val, 531);
});

test('si el contador se reinicia, suma solo tramos positivos', () => {
  const pts = [
    { ts: 1, val: 10 },
    { ts: 2, val: 15 },
    { ts: 3, val: 2 },
    { ts: 4, val: 8 },
  ];
  const inc = applyPeriodIncrementPoints(pts);
  assert.equal(inc[inc.length - 1].val, 5 + 2 + 6);
});
