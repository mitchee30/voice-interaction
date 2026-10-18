// Browser test: real Chromium, real Silero VAD, fake microphone, fake OpenAI.
//
//   npm run test:e2e
//
// The fake microphone plays e2e/fixtures/mic.wav:
//   1.0 s  silence
//   2.2 s  "one pearl milk tea please"         → order, a 6-second spoken reply starts
//   1.4 s  silence
//   1.7 s  "okay"     (over the reply)         → reply pauses, then CONTINUES (backchannel)
//   1.8 s  silence
//   3.0 s  "could you make it less sugar instead please" (over the reply)
//                                              → reply is dropped, drink changed
//   8   s  silence                             → after 4 s idle the mic is released

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
// tone.wav is 24 kHz 16-bit mono: send its samples as streamed PCM
function wavData(buf) {
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === 'data') return buf.subarray(o + 8, o + 8 + size);
    o += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}
const tonePcm = wavData(fs.readFileSync(path.join(here, 'fixtures', 'tone.wav')));

let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

// ---------- fake OpenAI ----------
const api = await startFakeOpenAI({
  // tell the three utterances apart by length (16 kHz 16-bit WAV, incl. ~0.3 s padding)
  transcripts: (n, wav) => {
    const sec = (wav.length - 44) / 32000;
    return sec > 3.1 ? 'make it less sugar' : sec > 2.3 ? 'one pearl milk tea please' : 'okay';
  },
  speech: tonePcm, // every sentence "sounds" like a 3-second tone
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
  await page.goto(`http://localhost:${PORT}/?debug&idle=4000`);
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
  ok('streamed reply audio started playing');

  const ignored = await waitEvent((e) => e[0] === 'bargein_ignored', '"okay" handled');
  assert.equal(ignored[1], 1);
  let log = await events();
  const iIgnored = log.findIndex((e) => e[0] === 'bargein_ignored');
  assert.ok(!log.slice(0, iIgnored).some((e) => e[0] === 'bargein'), 'reply must not be dropped for "okay"');
  assert.ok(log.slice(iIgnored).some((e) => e[0] === 'state' && e[1] === 'speaking') || (await page.evaluate(() => window.__client.state)) === 'speaking');
  ok('"okay" over the reply only paused it; it continued afterwards');

  const barge = await waitEvent((e) => e[0] === 'bargein', 'barge-in');
  assert.equal(barge[1], 1);
  ok('"make it less sugar" over the reply really interrupted it');

  const u2 = await waitEvent((e) => e[0] === 'user' && e[2] === 'make it less sugar', 'second request');
  assert.notEqual(u2[1], 1);
  await waitEvent((e) => e[0] === 'cart' && e[1].op === 'update', 'cart update');
  ok('second request was handled: drink changed to 70% sugar');

  const cartText = await page.textContent('#cart');
  assert.match(cartText, /珍珠奶茶/);
  assert.match(cartText, /七分糖/);
  ok('cart on the page shows the change');

  const serverLog = appLog.join('');
  assert.match(serverLog, /\[BARGE_IN\] \[turn=1\] not an interruption \(backchannel: 'okay'\)/);
  assert.match(serverLog, /\[BARGE_IN\] \[turn=1\] interrupted during sentence \d\/2/);
  ok('server log: "okay" resumed, the real request interrupted (and knows which sentence was heard)');

  const timing = await waitEvent((e) => e[0] === 'timing', 'timing');
  assert.ok(timing[1].responseMs > 0, JSON.stringify(timing[1]));
  ok(`latency measured: ${timing[1].responseMs} ms from end of speech to first sound`);

  await waitEvent((e) => e[0] === 'paused' && e[1] === 'idle', 'idle pause', 20000);
  assert.equal(await page.evaluate(() => window.__client.voiceEnabled), false);
  assert.match(await page.textContent('#toggle'), /继续/);
  ok('after 4 s of silence the microphone was released ("继续" button shown)');

  await page.click('#toggle');
  await page.waitForFunction(() => window.__client.voiceEnabled && window.__client.state === 'idle', null, { timeout: 15000 });
  ok('tapping "继续" turned the microphone back on, same conversation');

  const setHidden = (hidden) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { value: h, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await setHidden(true);
  await waitEvent((e) => e[0] === 'paused' && e[1] === 'hidden', 'hidden pause');
  assert.equal(await page.evaluate(() => window.__client.voiceEnabled), false);
  await setHidden(false);
  await page.waitForFunction(() => window.__client.voiceEnabled && window.__client.state === 'idle', null, { timeout: 15000 });
  ok('switching away from the page released the mic; coming back turned it on again');
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

  // typing while a reply is paused (customer started talking) must not leave audio muted
  await p2.fill('#input', 'make it less sugar');
  await p2.press('#input', 'Enter');
  await p2.waitForFunction(() => window.__client.state === 'speaking', null, { timeout: 10000 });
  await p2.evaluate(() => window.__client._hold());
  assert.equal(await p2.evaluate(() => window.__client.playCtx.state), 'suspended');
  await p2.fill('#input', 'one taro milk tea');
  await p2.press('#input', 'Enter');
  await p2.waitForFunction(() => window.__client.state === 'speaking' && window.__client.playCtx.state === 'running', null, { timeout: 10000 });
  ok('typing over a paused reply drops it and the new reply is audible');
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
