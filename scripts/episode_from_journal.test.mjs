import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractScriptSpeakerNames,
  validateScriptSpeakers,
} from './episode_from_journal.mjs';

const hosts = [
  { id: 'builtin_zh_kai', name: 'Kai' },
  { id: 'host_pika', name: 'PIKA' },
];

test('extracts unique speaker labels from a script', () => {
  assert.deepEqual(
    extractScriptSpeakerNames('Kai: 開場\nPIKA：追問\nKai: 收尾'),
    ['Kai', 'PIKA'],
  );
});

test('accepts speaker labels that match the live hosts', () => {
  assert.deepEqual(
    validateScriptSpeakers('Kai: 開場\npika: 追問', hosts),
    {
      expectedSpeakers: ['Kai', 'PIKA'],
      scriptSpeakers: ['Kai', 'pika'],
    },
  );
});

test('rejects a retired speaker label before submission', () => {
  assert.throws(
    () => validateScriptSpeakers('Kai: 開場\nLuna: 追問', hosts),
    /找不到 Luna.*只能使用 Kai、PIKA/,
  );
});
