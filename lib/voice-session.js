const DEFAULT_REALTIME_MODEL = 'gpt-realtime-1.5';
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${DEFAULT_REALTIME_MODEL}`;
const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-live-transcribe';
const DEFAULT_SAMPLE_RATE = 24000;

function turnDetectionConfig(value) {
  if (value === 'semantic-low') {
    return { type: 'semantic_vad', eagerness: 'low' };
  }
  if (value === 'server') {
    return {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500
    };
  }
  return { type: 'semantic_vad', eagerness: 'auto' };
}

function buildVoiceSessionUpdate({
  delay = 'low',
  turnDetection = 'semantic-auto',
  model = DEFAULT_TRANSCRIPTION_MODEL
} = {}) {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: DEFAULT_SAMPLE_RATE },
          transcription: {
            model,
            delay
          },
          turn_detection: turnDetectionConfig(turnDetection)
        }
      }
    }
  };
}

function encodeAudioAppend(audio) {
  const buffer = Buffer.isBuffer(audio)
    ? audio
    : audio instanceof ArrayBuffer
      ? Buffer.from(audio)
      : ArrayBuffer.isView(audio)
        ? Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
        : null;
  if (!buffer || !buffer.length) return null;
  return {
    type: 'input_audio_buffer.append',
    audio: buffer.toString('base64')
  };
}

function parseVoiceEvent(raw) {
  try {
    const text = Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString('utf8')
        : String(raw);
    const event = JSON.parse(text);
    return event && typeof event === 'object' ? event : null;
  } catch {
    return null;
  }
}

function errorFromEvent(event) {
  const message = event?.error?.message || event?.message || 'Realtime voice session error.';
  return new Error(String(message).slice(0, 1000));
}

class RealtimeVoiceSession {
  constructor({
    apiKey,
    onEvent = () => {},
    onError = () => {},
    logger = console,
    WebSocketImpl = require('ws'),
    realtimeUrl = REALTIME_URL
  } = {}) {
    this.apiKey = apiKey;
    this.onEvent = onEvent;
    this.onError = onError;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.realtimeUrl = realtimeUrl;
    this.connection = null;
  }

  isOpen() {
    const open = this.WebSocketImpl.OPEN === undefined ? 1 : this.WebSocketImpl.OPEN;
    return Boolean(this.connection && this.connection.socket.readyState === open);
  }

  start(options = {}) {
    if (this.isOpen()) return Promise.resolve({ connected: true });
    if (this.connection?.promise) return this.connection.promise;
    if (!this.apiKey) return Promise.reject(new Error('OpenAI API key is missing. Put OPENAI_API_KEY in .env and restart the app.'));

    let socket;
    try {
      socket = new this.WebSocketImpl(this.realtimeUrl, {
        headers: { authorization: `Bearer ${this.apiKey}` }
      });
    } catch (error) {
      return Promise.reject(error);
    }

    const connection = {
      socket,
      settled: false,
      intentionalClose: false,
      resolve: null,
      reject: null,
      promise: null
    };
    connection.promise = new Promise((resolve, reject) => {
      connection.resolve = resolve;
      connection.reject = reject;
    });
    connection.promise.catch(() => {});
    this.connection = connection;

    const isCurrent = () => this.connection === connection;
    const fail = (error) => {
      if (connection.settled) return;
      connection.settled = true;
      if (isCurrent()) this.connection = null;
      connection.reject(error);
    };
    const notifyError = (error) => {
      try {
        this.onError(error);
      } catch (callbackError) {
        this.logger.error?.('Voice error callback failed:', callbackError);
      }
    };

    socket.on('open', () => {
      if (!isCurrent()) return;
      try {
        socket.send(JSON.stringify(buildVoiceSessionUpdate(options)));
        connection.settled = true;
        connection.resolve({ connected: true });
        this.onEvent({ type: 'session.opened' });
      } catch (error) {
        notifyError(error);
        fail(error);
      }
    });

    socket.on('message', (raw) => {
      if (!isCurrent()) return;
      const event = parseVoiceEvent(raw);
      if (!event) return;
      if (event.type === 'error') {
        const error = errorFromEvent(event);
        notifyError(error);
        this.stop();
        return;
      }
      try {
        this.onEvent(event);
      } catch (callbackError) {
        this.logger.error?.('Voice event callback failed:', callbackError);
      }
    });

    socket.on('error', (error) => {
      if (!isCurrent()) return;
      notifyError(error);
      if (!connection.settled) fail(error);
    });

    socket.on('close', () => {
      if (!isCurrent()) return;
      const intentional = connection.intentionalClose;
      this.connection = null;
      if (!connection.settled) {
        fail(new Error('Realtime voice connection closed before it was ready.'));
      } else if (!intentional) {
        try {
          this.onEvent({ type: 'session.closed' });
        } catch (callbackError) {
          this.logger.error?.('Voice event callback failed:', callbackError);
        }
      }
    });

    return connection.promise;
  }

  sendAudio(audio) {
    if (!this.isOpen()) return false;
    const event = encodeAudioAppend(audio);
    if (!event) return false;
    try {
      this.connection.socket.send(JSON.stringify(event));
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  commit() {
    if (!this.isOpen()) return false;
    try {
      this.connection.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  stop() {
    const connection = this.connection;
    if (!connection) return;
    this.connection = null;
    connection.intentionalClose = true;
    if (!connection.settled) {
      connection.settled = true;
      connection.reject(new Error('Realtime voice session stopped.'));
    }
    try {
      connection.socket.close();
    } catch {
      try { connection.socket.terminate?.(); } catch {}
    }
  }
}

module.exports = {
  REALTIME_URL,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_TRANSCRIPTION_MODEL,
  buildVoiceSessionUpdate,
  encodeAudioAppend,
  parseVoiceEvent,
  RealtimeVoiceSession
};
