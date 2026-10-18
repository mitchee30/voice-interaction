'use strict';

// All tunable settings in one place. Most model settings can be overridden
// with environment variables (see .env.example).

const env = process.env;

module.exports = {
  // ---------- listening (runs in the browser; sent to the client on connect) ----------
  sampleRate: 16000, // Hz, mono 16-bit
  chunkDurationMs: 32, // one Silero VAD v5 frame = 512 samples
  speechThreshold: 0.5, // VAD probability above this = speech
  silenceThreshold: 0.35, // below this = silence
  silenceTimeoutMs: 500, // this much silence ends an utterance
  minUtteranceMs: 250, // shorter sounds (a cough, a click) are dropped
  maxUtteranceMs: 12000, // force-send an utterance this long
  preSpeechPadMs: 300, // audio kept from just before speech started
  // While the assistant is talking, be stricter so its own voice coming out of
  // the speaker is less likely to interrupt it.
  bargeInThreshold: 0.7,
  bargeInMinMs: 400,

  // ---------- speaking: how the streamed reply is cut for TTS ----------
  sentenceDelimiters: ['。', '！', '？', '；', '\n', '!', '?'],
  softDelimiters: ['，', ','],
  softSplitLength: 26, // past this many characters a comma also ends a piece
  maxPieceLength: 90,

  // ---------- models ----------
  provider: env.VOICE_PROVIDER || 'auto', // auto | openai | mock
  openai: {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    chatModel: env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
    asrModel: env.OPENAI_ASR_MODEL || 'gpt-transcribe',
    ttsModel: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: env.OPENAI_TTS_VOICE || 'marin',
    ttsFormat: env.OPENAI_TTS_FORMAT || 'mp3',
    ttsInstructions: 'You are friendly staff at a bubble tea shop. Speak warmly, clearly and a little briskly.',
    reasoningEffort: env.OPENAI_REASONING_EFFORT || undefined,
    maxReplyTokens: 400,
    timeoutMs: 20000,
  },

  // ---------- conversation ----------
  defaultLang: 'zh', // zh | en
  maxToolRounds: 4,
  maxHistoryMessages: 16,

  // ---------- limits (protect the API bill) ----------
  maxTurnsPerMinute: 20, // per connection
  maxTurnsPerDay: Number(env.VOICE_MAX_TURNS_PER_DAY || 3000), // whole server, 0 = unlimited
  maxAudioSeconds: 15,
  maxTextChars: 500,

  // ---------- server ----------
  wsPath: '/voice/ws',
  assetPrefix: '/voice',
  heartbeatMs: 25000,
  logLevel: env.VOICE_LOG_LEVEL || 'info', // info | warn | error | silent
};
