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
  idleStopMs: 90000, // stop listening after this long without speech (0 = never)

  // ---------- turn taking ----------
  // Talking over the assistant first PAUSES it. If the words turn out to be its
  // own echo, a "嗯 / 对 / ok", or nothing, playback continues where it stopped;
  // otherwise the old reply is dropped. (false = stop immediately on any speech)
  smartBargeIn: true,
  // An utterance that ends like "…，还有" / "… and" waits this long for the rest.
  incompleteGraceMs: 1200,

  // ---------- speaking: how the streamed reply is cut for TTS ----------
  sentenceDelimiters: ['。', '！', '？', '；', '\n', '!', '?'],
  softDelimiters: ['，', ','],
  softSplitLength: 26, // past this many characters a comma also ends a piece
  maxPieceLength: 90,
  ttsConcurrency: 3, // TTS requests in flight per conversation

  // ---------- models ----------
  provider: env.VOICE_PROVIDER || 'auto', // auto | openai | mock
  openai: {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    chatModel: env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
    asrModel: env.OPENAI_ASR_MODEL || 'gpt-transcribe',
    ttsModel: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    ttsVoice: env.OPENAI_TTS_VOICE || 'marin',
    // pcm = raw 24 kHz 16-bit audio streamed while it is generated (fastest).
    // mp3 / wav / aac / opus = whole file per sentence.
    ttsFormat: env.OPENAI_TTS_FORMAT || 'pcm',
    ttsSampleRate: 24000,
    ttsInstructions:
      'You are friendly staff at a bubble tea shop. Speak warmly, clearly and a little briskly. Chinese text is Mandarin: use natural standard Mandarin pronunciation.',
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
  maxTurnsPerIpPerHour: Number(env.VOICE_MAX_TURNS_PER_IP_PER_HOUR || 200),
  maxConnectionsPerIp: 10,
  // Behind a proxy (Render, Heroku, Cloudflare, nginx) the client IP is in
  // X-Forwarded-For. Only turn this on when such a proxy is in front.
  trustProxy: env.VOICE_TRUST_PROXY === '1' || env.VOICE_TRUST_PROXY === 'true',

  // ---------- sessions ----------
  sessionResumeMs: 5 * 60 * 1000, // a reconnect within this time keeps the conversation
  maxStoredSessions: 2000,

  // ---------- server ----------
  wsPath: '/voice/ws',
  assetPrefix: '/voice',
  heartbeatMs: 25000,
  logLevel: env.VOICE_LOG_LEVEL || 'info', // info | warn | error | silent
};
