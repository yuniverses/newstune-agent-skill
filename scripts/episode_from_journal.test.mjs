import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSeriesSnapshot,
  buildSubmitIdempotencyKey,
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

test('series binding preserves the durable production brief for scheduled runs', () => {
  assert.deepEqual(
    buildSeriesSnapshot({
      title: 'AI Weekly',
      topic: 'Applied AI',
      language: 'zh-TW',
      hostIds: ['host-1'],
      episodeFormat: 'deep',
      visibility: 'public',
      style: '冷靜、具體、避免炒作',
      perspective: '產品負責人視角',
      publicSlug: 'ai-weekly',
      rssEnabled: true,
      targetDurationMinutes: 18,
      customPrompts: {
        gatherContent: '每週讀指定 RSS 與本機開發日誌。',
        generateScript: '先結論，再用證據展開。',
        generateFinalScript: '',
      },
    }),
    {
      title: 'AI Weekly',
      topic: 'Applied AI',
      language: 'zh-TW',
      hostIds: ['host-1'],
      episodeFormat: 'deep',
      visibility: 'public',
      style: '冷靜、具體、避免炒作',
      perspective: '產品負責人視角',
      publicSlug: 'ai-weekly',
      rssEnabled: true,
      customPrompts: {
        gatherContent: '每週讀指定 RSS 與本機開發日誌。',
        generateScript: '先結論，再用證據展開。',
      },
      targetDurationMinutes: 18,
    },
  );
});

test('scheduled submit idempotency is stable for one checkpoint and content payload', () => {
  const input = {
    slug: 'product-weekly',
    checkpoint: '2026-07-18T01:00:00.000Z',
    title: '本週產品決策',
    summary: '整理三項已完成的產品決策。',
    script: 'Kai: 開場\nPIKA: 分析',
  };
  const first = buildSubmitIdempotencyKey(input);
  assert.equal(first, buildSubmitIdempotencyKey({ ...input }));
  assert.notEqual(first, buildSubmitIdempotencyKey({ ...input, checkpoint: '2026-07-25T01:00:00.000Z' }));
  assert.notEqual(first, buildSubmitIdempotencyKey({ ...input, script: `${input.script}\nKai: 收尾` }));
  assert.match(first, /^episode-journal-product-weekly-[a-f0-9]{32}$/);
});
