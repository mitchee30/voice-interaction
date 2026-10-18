// Browser test: real Chromium, real Silero VAD, fake microphone, fake OpenAI.
//
//   npm run test:e2e
//
// The fake microphone plays e2e/fixtures/mic.wav: silence, "one pearl milk tea
// please", a pause, then "make it less sugar" while the assistant is still
// talking (that second sentence must interrupt it).

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { startFakeOpenAI, textChunks, toolChunks } = require('../test/fake_openai.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });
const PORT = 8799;
const tone = fs.readFileSync(path.join(here, 'fixtures', 'tone.wav'));

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

// ---------- fake OpenAI ----------
const api = await startFakeOpenAI({
  transcripts: ['one pearl milk tea please', 'make it less sugar'],
  speech: tone, // every sentence "sounds" like a 3-second tone
  chat(body) {
    const msgs = body.messages;
    const last = msgs[msgs.length - 1];
    if (last.role === 'tool') {
      const r = JSON.parse(last.content);
      return textChunks(`OK, I added ${r.label}. Anything else?`);
    }
    if (/less sugar/.test(last.content)) {
      const line = /line_id=(\w+)/.exec(msgs[0].content)[1];
      return toolChunks('update_cart_line', { line_id: line, options: { sugar: '70' } });
    }
    if (/pearl/.test(last.content)) return toolChunks('add_to_cart', { item_id: 'pearl-milk-tea', qty: 1 });
    return textChunks('Sorry?');
  },
});

// ---------- the demo app, pointed at the fake API ----------
const app = spawn(process.execPath, [path.join(root, 'app_order.js')], {
  env: { ...process.env, PORT: String(PORT), OPENAI_API_KEY: api.apiKey, OPENAI_BASE_URL: api.baseURL, VOICE_PROVIDER: 'openai' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const appLog = [];
app.stdout.on('data', (d) => appLog.push(String(d)));
app.stderr.on('data', (d) => appLog.push(String(d)));
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('app did not start')), 5000);
  app.stdout.on('data', (d) => String(d).includes('http://localhost') && (clearTimeout(t), resolve()));
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.join(here, 'fixtures', 'mic.wav')}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

let failed = false;
try {
  // ---------- 1. voice: talk, get a spoken reply, interrupt it ----------
  console.log('voice flow');
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(m.text()));
  page.on('pageerror', (e) => consoleLines.push(`PAGEERROR ${e.message}`));
  await page.goto(`http://localhost:${PORT}/?debug`);
  await page.click('#toggle');

  const events = () => page.evaluate(() => window.__voiceLog);
  const waitEvent = async (pred, what, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const ev = (await events()).find(pred);
      if (ev) return ev;
      await page.waitForTimeout(100);
    }
    throw new Error(`timed out waiting for ${what}\n${JSON.stringify(await events())}\n${consoleLines.join('\n')}`);
  };

  const ready = await waitEvent((e) => e[0] === 'ready', 'ready');
  assert.equal(ready[1].provider, 'openai');
  assert.equal(ready[1].voice, true);
  ok('connected with voice on');
  await page.waitForFunction(() => window.__client.voiceEnabled, null, { timeout: 15000 });
  ok('Silero VAD loaded in the browser and the mic is open');

  const u1 = await waitEvent((e) => e[0] === 'user' && e[1] === 1, 'first utterance');
  assert.equal(u1[2], 'one pearl milk tea please');
  ok('VAD cut the first sentence on its own and it was transcribed');

  await waitEvent((e) => e[0] === 'cart' && e[1].op === 'add', 'cart add');
  ok('AI added the drink to the cart');

  await waitEvent((e) => e[0] === 'state' && e[1] === 'speaking', 'speaking');
  ok('reply audio started playing');

  const barge = await waitEvent((e) => e[0] === 'bargein', 'barge-in');
  assert.equal(barge[1], 1);
  ok('second sentence interrupted the playing reply (barge-in)');

  const u2 = await waitEvent((e) => e[0] === 'user' && e[1] === 2, 'second utterance');
  assert.equal(u2[2], 'make it less sugar');
  await waitEvent((e) => e[0] === 'cart' && e[1].op === 'update', 'cart update');
  ok('second sentence was handled: drink changed to 70% sugar');

  const cartText = await page.textContent('#cart');
  assert.match(cartText, /珍珠奶茶/);
  assert.match(cartText, /七分糖/);
  ok('cart on the page shows the change');

  const serverLog = appLog.join('');
  assert.match(serverLog, /\[BARGE_IN\] \[turn=1\]/);
  ok('server logged the barge-in for turn 1');
  assert.ok(!consoleLines.some((l) => l.startsWith('PAGEERROR')), consoleLines.join('\n'));
  await page.screenshot({ path: path.join(out, 'voice.png') });
  await ctx.close();

  // ---------- 2. typing (no mic), phone size ----------
  console.log('typing flow (phone size)');
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p2 = await ctx2.newPage();
  const errors2 = [];
  p2.on('pageerror', (e) => errors2.push(e.message));
  await p2.goto(`http://localhost:${PORT}/?novoice`);
  await p2.fill('#input', 'one pearl milk tea');
  await p2.press('#input', 'Enter');
  await p2.waitForFunction(() => window.__voiceLog.some((e) => e[0] === 'reply'), null, { timeout: 10000 });
  const reply = await p2.evaluate(() => window.__voiceLog.find((e) => e[0] === 'reply')[2]);
  assert.match(reply, /added 珍珠奶茶/i);
  ok('typed order got a reply');
  const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
  ok('no sideways scrolling at phone width');
  assert.deepEqual(errors2, []);
  await p2.screenshot({ path: path.join(out, 'phone.png'), fullPage: true });
  await ctx2.close();
  console.log(`\nall ${step} checks passed; screenshots in e2e/out/`);
} catch (err) {
  failed = true;
  console.error('\nFAILED:', err.message);
  console.error('--- app log ---\n' + appLog.join(''));
} finally {
  await browser.close();
  app.kill();
  await api.close();
}
process.exit(failed ? 1 : 0);
