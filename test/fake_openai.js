'use strict';

// A stand-in for the OpenAI API (transcriptions, streamed chat with tool calls,
// speech), so the real provider code can be tested without a key or network.

const http = require('http');

function sse(res, chunks, delay = 5) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let i = 0;
  const next = () => {
    if (res.destroyed) return;
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
      setTimeout(next, delay);
    } else {
      res.end('data: [DONE]\n\n');
    }
  };
  next();
}

function textChunks(text) {
  const out = [{ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }];
  for (const piece of text.match(/.{1,3}/gsu)) out.push({ choices: [{ index: 0, delta: { content: piece } }] });
  out.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  return out;
}

function toolChunks(name, args) {
  const json = JSON.stringify(args);
  const out = [{ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] } }] }];
  for (let i = 0; i < json.length; i += 7) {
    out.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(i, i + 7) } }] } }] });
  }
  out.push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  return out;
}

/** Default script: orders a pearl milk tea when asked, then confirms. */
function defaultChat(body) {
  const msgs = body.messages;
  const last = msgs[msgs.length - 1];
  if (last.role === 'tool') {
    const r = JSON.parse(last.content);
    return textChunks(r.ok ? `好的，加了${r.label}。还要别的吗？` : `抱歉，${r.error}。`);
  }
  if (/pearl|珍珠/i.test(last.content)) return toolChunks('add_to_cart', { item_id: 'pearl-milk-tea', qty: 1, options: { ice: 'less' } });
  return textChunks('不好意思，请再说一遍。');
}

async function startFakeOpenAI({ apiKey = 'sk-test', transcripts = ['one pearl milk tea please'], speech = Buffer.from('FAKEAUDIO'), chat = defaultChat, latency = 0 } = {}) {
  const calls = { transcriptions: [], chat: [], speech: [] };
  let asrIndex = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
    }
    if (latency) await new Promise((r) => setTimeout(r, latency));
    if (req.url === '/v1/audio/transcriptions') {
      const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
      const file = form.get('file');
      calls.transcriptions.push({ model: form.get('model'), prompt: form.get('prompt'), filename: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      const text = typeof transcripts === 'function' ? transcripts(calls.transcriptions.length) : transcripts[Math.min(asrIndex++, transcripts.length - 1)];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text }));
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      calls.chat.push(body);
      return sse(res, chat(body));
    }
    if (req.url === '/v1/audio/speech') {
      const body = JSON.parse(raw);
      calls.speech.push(body);
      const audio = typeof speech === 'function' ? speech(body) : speech;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': audio.length });
      return res.end(audio);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { startFakeOpenAI, textChunks, toolChunks, defaultChat };
