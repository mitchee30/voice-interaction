'use strict';

// Entry point: WebSocket server for the voice controller + the browser files.
//
//   const { createVoiceServer } = require('voice-interaction');
//   const voice = createVoiceServer({ getMenu, shopName: 'My Tea Shop' });
//   app.use(voice.assets());          // serves /voice/audio_client.js (+ VAD files if installed)
//   voice.attach(httpServer);         // WebSocket at /voice/ws

const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config_data');
const { VoiceAssistantController, makeLogger } = require('./audio_interaction');
const { createOpenAIProvider } = require('./providers/openai');
const { createMockProvider } = require('./providers/mock');
const menuStore = require('./menu_store');

const PUBLIC_DIR = path.join(__dirname, 'public');

function resolveProvider(p, log) {
  if (p && typeof p === 'object') return p;
  const want = p || config.provider;
  if (want === 'mock') return createMockProvider();
  if (want === 'openai') return createOpenAIProvider();
  if (want === 'auto') {
    if (config.openai.apiKey || process.env.OPENAI_API_KEY) return createOpenAIProvider();
    log('CTRL', 0, 'OPENAI_API_KEY is not set: using the demo provider (typing only, no real AI)', 'warn');
    return createMockProvider();
  }
  throw new Error(`unknown voice provider ${want}`);
}

/** Shared daily cap so a leaked page can't run up a big AI bill. */
function dailyBudget(max) {
  if (!max) return null;
  let day = '';
  let used = 0;
  return {
    take() {
      const today = new Date().toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        used = 0;
      }
      if (used >= max) return false;
      used += 1;
      return true;
    },
  };
}

function originAllowed(req, allowed) {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (curl, tests)
  if (Array.isArray(allowed)) return allowed.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * options:
 *   getMenu()           required; returns the menu (see menu_store.js), may be async
 *   provider            'auto' | 'openai' | 'mock' | custom provider object
 *   shopName            used in the AI prompt
 *   instructions        extra notes for the AI ("we close at 9pm", ...)
 *   defaultLang         'zh' | 'en'
 *   allowedOrigins      origins allowed to connect; default: same host only
 *   maxTurnsPerMinute, maxTurnsPerDay, maxAudioSeconds   see config_data.js
 *   logLevel, log(level, line)
 *   onUserSpeech, onAssistantReplyStart, onAssistantReplyChunk, onAssistantReplyEnd, onCartChange
 */
function createVoiceServer(options = {}) {
  if (typeof options.getMenu !== 'function') throw new Error('createVoiceServer: getMenu() is required');
  const log = makeLogger(options.logLevel || config.logLevel, options.log);
  const provider = resolveProvider(options.provider, log);
  const controllerOptions = {
    ...options,
    provider,
    budget: dailyBudget(options.maxTurnsPerDay === undefined ? config.maxTurnsPerDay : options.maxTurnsPerDay),
  };
  const maxAudio = 4 + 44 + config.sampleRate * 2 * (options.maxAudioSeconds || config.maxAudioSeconds);

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxAudio + 1024, perMessageDeflate: false });
  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => log('WS', 0, `socket error: ${err.message}`, 'warn'));
    new VoiceAssistantController(ws, controllerOptions);
    log('CTRL', 0, `client connected (${provider.name})`);
  });

  // Keep connections alive through proxies (Render, Cloudflare, ...).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  function handleUpgrade(req, socket, head) {
    if (!originAllowed(req, options.allowedOrigins)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  const api = {
    wss,
    provider,
    handleUpgrade,
    /** Listens for WebSocket upgrades on `wsPath` of an http.Server. */
    attach(server, wsPath = config.wsPath) {
      server.on('upgrade', (req, socket, head) => {
        if ((req.url || '').split('?')[0] === wsPath) handleUpgrade(req, socket, head);
      });
      return api;
    },
    /** Middleware serving the browser files under `prefix` (default /voice). */
    assets(prefix) {
      return assetHandler(prefix);
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
  return api;
}

// ---------- browser files ----------

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
};

// Finds node_modules/<pkg>/dist without going through the package's "exports"
// (onnxruntime-web does not export its dist files).
function tryResolveDir(file) {
  const [scopeOrName, maybeName] = file.split('/');
  const pkg = scopeOrName.startsWith('@') ? `${scopeOrName}/${maybeName}` : scopeOrName;
  const rest = file.slice(pkg.length + 1);
  for (const base of require.resolve.paths(pkg) || []) {
    const full = path.join(base, pkg, rest);
    if (fs.existsSync(full)) return path.dirname(full);
  }
  return null;
}

// Only files in this table are ever served.
function assetTable() {
  const table = new Map();
  for (const f of ['audio_client.js']) table.set(`/${f}`, path.join(PUBLIC_DIR, f));
  // Optional self-hosted VAD files (when @ricky0123/vad-web and onnxruntime-web
  // are installed). Without them the browser loads the same pinned versions
  // from jsDelivr.
  const vadDir = tryResolveDir('@ricky0123/vad-web/dist/bundle.min.js');
  const ortDir = tryResolveDir('onnxruntime-web/dist/ort.wasm.min.js');
  if (vadDir && ortDir) {
    for (const f of ['bundle.min.js', 'vad.worklet.bundle.min.js', 'silero_vad_v5.onnx', 'silero_vad_legacy.onnx']) {
      table.set(`/vendor/vad/${f}`, path.join(vadDir, f));
    }
    for (const f of ['ort.wasm.min.js', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) {
      table.set(`/vendor/ort/${f}`, path.join(ortDir, f));
    }
  }
  return table;
}

function assetHandler(prefix = config.assetPrefix) {
  const table = assetTable();
  return function voiceAssets(req, res, next) {
    const url = (req.url || '').split('?')[0];
    const file = url.startsWith(prefix + '/') ? table.get(url.slice(prefix.length)) : null;
    if (!file) return next ? next() : notFound(res);
    fs.stat(file, (err, st) => {
      if (err) return next ? next() : notFound(res);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': url.includes('/vendor/') ? 'public, max-age=604800, immutable' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  };
}

function notFound(res) {
  res.writeHead(404);
  res.end();
}

module.exports = {
  createVoiceServer,
  assetHandler,
  hasLocalVendor: () => assetTable().has('/vendor/vad/bundle.min.js'),
  VoiceAssistantController,
  createOpenAIProvider,
  createMockProvider,
  config,
  ...menuStore,
};
