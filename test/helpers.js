'use strict';

const http = require('http');
const WebSocket = require('ws');
const { createVoiceServer } = require('..');

const MENU = require('../data/menu.json');

async function startVoice(opts = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const voice = createVoiceServer({ getMenu: () => MENU, shopName: 'Test Tea', logLevel: 'silent', ...opts });
  voice.attach(server, '/voice/ws');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/voice/ws`,
    port,
    voice,
    async close() {
      voice.close();
      await new Promise((r) => server.close(r));
    },
  };
}

/** WebSocket test client that records every message. */
async function connect(url, headers) {
  const ws = new WebSocket(url, { headers });
  const msgs = [];
  const waiters = [];
  ws.on('message', (data, isBinary) => {
    const m = isBinary
      ? { type: 'audio', turn: data.readUInt32BE(0), seq: data.readUInt32BE(4), bytes: data.subarray(8) }
      : JSON.parse(String(data));
    msgs.push(m);
    for (const w of [...waiters]) w();
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  const client = {
    ws,
    msgs,
    send: (obj) => ws.send(JSON.stringify(obj)),
    sendAudio(turn, wav) {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(turn);
      ws.send(Buffer.concat([head, wav]));
    },
    waitFor(pred, ms = 3000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const found = msgs.find(pred);
          if (found) {
            waiters.splice(waiters.indexOf(check), 1);
            clearTimeout(timer);
            resolve(found);
          }
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error(`timeout; got: ${JSON.stringify(msgs.map((m) => m.type + ':' + (m.turn ?? '')))}`));
        }, ms);
        waiters.push(check);
        check();
      });
    },
    of: (type, turn) => msgs.filter((m) => m.type === type && (turn === undefined || m.turn === turn)),
    close: () => ws.close(),
  };
  return client;
}

/** A tiny valid WAV (silence) — content doesn't matter to fake providers. */
function fakeWav(ms = 300, tag = 0) {
  const n = Math.round((16000 * ms) / 1000);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  if (n) buf.writeInt16LE(tag, 44); // lets fake ASR tell utterances apart
  return buf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startVoice, connect, fakeWav, sleep, MENU };
