'use strict';

// OpenAI provider: speech-to-text, chat with tools (streamed), text-to-speech.
// Uses plain fetch, so any OpenAI-compatible endpoint works for chat via baseURL.

const config = require('../config_data');

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac', opus: 'audio/ogg', flac: 'audio/flac' };

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== '') out[k] = v;
  return out;
}

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function failure(res, what) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      detail = JSON.parse(body).error?.message || body;
    } catch {
      detail = body;
    }
  } catch {}
  const err = new Error(`${what} failed: HTTP ${res.status} ${String(detail).slice(0, 300)}`);
  err.status = res.status;
  return err;
}

/** Parses a text/event-stream response body into JSON payloads. */
async function* sseJson(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // ignore keep-alive or malformed lines
      }
    }
  }
}

function createOpenAIProvider(options = {}) {
  const cfg = { ...config.openai, apiKey: config.openai.apiKey || process.env.OPENAI_API_KEY, ...clean(options) };
  if (!cfg.apiKey) throw new Error('OpenAI provider needs OPENAI_API_KEY');
  const fetchImpl = options.fetch || globalThis.fetch;
  const base = cfg.baseURL.replace(/\/+$/, '');
  const auth = { Authorization: `Bearer ${cfg.apiKey}` };

  async function transcribe(wav, { prompt, signal } = {}) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', cfg.asrModel);
    if (prompt) form.append('prompt', prompt);
    const res = await fetchImpl(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: auth,
      body: form,
      signal: withTimeout(signal, cfg.timeoutMs),
    });
    if (!res.ok) throw await failure(res, 'transcription');
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      return typeof j.text === 'string' ? j.text : '';
    } catch {
      return body;
    }
  }

  /**
   * Streams one model response. Yields {type:'text', text} as tokens arrive and,
   * at the end, {type:'tool_calls', calls:[{id, name, arguments}]} if the model called tools.
   */
  async function* chat({ messages, tools, signal }) {
    const body = {
      model: cfg.chatModel,
      messages,
      stream: true,
      max_completion_tokens: cfg.maxReplyTokens,
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeout(signal, cfg.timeoutMs),
    });
    if (!res.ok) throw await failure(res, 'chat');
    const calls = [];
    for await (const chunk of sseJson(res.body)) {
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: 'text', text: delta.content };
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? calls.length;
        calls[i] = calls[i] || { id: '', name: '', arguments: '' };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
      }
    }
    const done = calls.filter(Boolean);
    if (done.length) yield { type: 'tool_calls', calls: done };
  }

  async function synthesize(input, { signal } = {}) {
    const body = { model: cfg.ttsModel, voice: cfg.ttsVoice, input, response_format: cfg.ttsFormat };
    if (cfg.ttsInstructions && /^gpt-/.test(cfg.ttsModel)) body.instructions = cfg.ttsInstructions;
    const res = await fetchImpl(`${base}/audio/speech`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: withTimeout(signal, cfg.timeoutMs),
    });
    if (!res.ok) throw await failure(res, 'speech');
    return { audio: Buffer.from(await res.arrayBuffer()), mime: MIME[cfg.ttsFormat] || 'application/octet-stream' };
  }

  return {
    name: 'openai',
    capabilities: { asr: true, tts: true },
    config: { chatModel: cfg.chatModel, asrModel: cfg.asrModel, ttsModel: cfg.ttsModel, ttsVoice: cfg.ttsVoice },
    transcribe,
    chat,
    synthesize,
  };
}

module.exports = { createOpenAIProvider, sseJson };
