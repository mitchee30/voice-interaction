'use strict';

// Demo app: a voice ordering page for a sample tea shop.
//
//   npm install
//   OPENAI_API_KEY=sk-... npm start      → http://localhost:8787
//   npm start                            → demo mode without a key (typing only)

const fs = require('fs');
const path = require('path');
const http = require('http');

// Load .env before the library reads its settings.
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { createVoiceServer, hasLocalVendor } = require('./index');

const MENU_FILE = path.join(__dirname, 'data', 'menu.json');
const PAGE_FILE = path.join(__dirname, 'app_order.html');
const PORT = Number(process.env.PORT || 8787);

function readMenu() {
  return JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
}

const voice = createVoiceServer({
  getMenu: readMenu,
  shopName: readMenu().shopName,
  instructions: 'This is a demo shop. Pickup only.',
});

const serveAssets = voice.assets('/voice');

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (url === '/' || url === '/index.html') {
    const html = fs
      .readFileSync(PAGE_FILE, 'utf8')
      .replace('"__LOCAL_VENDOR__"', hasLocalVendor() ? 'true' : 'false');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (url === '/menu.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(readMenu()));
  }
  serveAssets(req, res, () => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
});

voice.attach(server, '/voice/ws');

server.listen(PORT, () => {
  console.log(`voice ordering demo: http://localhost:${PORT}  (AI: ${voice.provider.name})`);
});

module.exports = { server, voice };
