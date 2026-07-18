import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSchedulePrompt } from './journal_setup.mjs';

const scriptPath = fileURLToPath(new URL('./journal_setup.mjs', import.meta.url));

function samplePodcast() {
  return {
    seriesId: 'series-weekly',
    mode: 'script_to_audio',
    episodeVisibility: 'public',
    extraSources: [
      { type: 'rss', url: 'https://example.com/feed.xml', priority: 'required' },
      { type: 'notion', page: 'Product Decisions', token: 'must-not-leak' },
    ],
    seriesSnapshot: {
      title: 'Product Weekly',
      topic: '產品決策與開發進展',
      language: 'zh-TW',
      hostIds: ['host-kai', 'host-luna'],
      episodeFormat: 'deep',
      targetDurationMinutes: 20,
      visibility: 'public',
      rssEnabled: true,
      style: '冷靜、編輯式、先結論後證據',
      perspective: '產品負責人視角',
      customPrompts: {
        gatherContent: '指定 RSS 必讀；Git 與決策日誌為優先來源；排除未驗證社群傳言。',
        generateScript: '雙主持人，以編輯和產品負責人的對談呈現。',
        generateFinalScript: '發布前核對引用、隱私、主持人名稱與重複內容。',
      },
    },
  };
}

test('builds a self-contained scheduled execution prompt without secrets', () => {
  const prompt = buildSchedulePrompt({
    slug: 'product-weekly',
    projectDir: '/journal/product-weekly',
    sourceCwd: '/workspace/product',
    podcast: samplePodcast(),
    maxCreditsPerRun: 80,
  });

  assert.match(prompt, /不要詢問問題、不要等待逐次確認/);
  assert.match(prompt, /series-weekly/);
  assert.match(prompt, /\/journal\/product-weekly\/entries/);
  assert.match(prompt, /\/workspace\/product/);
  assert.match(prompt, /https:\/\/example\.com\/feed\.xml/);
  assert.match(prompt, /指定 RSS 必讀/);
  assert.match(prompt, /雙主持人/);
  assert.match(prompt, /80 credits/);
  assert.match(prompt, /自動確認該集為 public/);
  assert.match(prompt, /RSS 維持既有狀態/);
  assert.doesNotMatch(prompt, /must-not-leak/);
});

test('schedule-prompt writes an auditable prompt and requires a credit ceiling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'newstune-schedule-test-'));
  const configDir = path.join(root, 'config');
  const journalRoot = path.join(root, 'journal');
  const projectDir = path.join(journalRoot, 'product-weekly');
  const sourceCwd = path.join(root, 'workspace');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(sourceCwd, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ journalRoot }));
  fs.writeFileSync(path.join(projectDir, 'podcast.json'), JSON.stringify(samplePodcast()));

  const baseArgs = [scriptPath, 'schedule-prompt', '--project', 'product-weekly', '--source-cwd', sourceCwd];
  const missingLimit = spawnSync(process.execPath, baseArgs, {
    encoding: 'utf8',
    env: { ...process.env, NEWSTUNE_AGENT_CONFIG_DIR: configDir },
  });
  assert.equal(missingLimit.status, 1);
  assert.match(missingLimit.stderr, /max-credits-per-run/);

  const generated = spawnSync(process.execPath, [...baseArgs, '--max-credits-per-run', '80'], {
    encoding: 'utf8',
    env: { ...process.env, NEWSTUNE_AGENT_CONFIG_DIR: configDir },
  });
  assert.equal(generated.status, 0, generated.stderr);
  const result = JSON.parse(generated.stdout);
  assert.equal(result.episodeVisibility, 'public');
  assert.equal(result.maxCreditsPerRun, 80);
  assert.equal(result.promptSha256.length, 64);
  assert.equal(fs.readFileSync(result.promptPath, 'utf8').trim(), result.prompt.trim());
  assert.doesNotMatch(result.prompt, /must-not-leak/);
});
