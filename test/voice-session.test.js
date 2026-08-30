const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_SAMPLE_RATE,
  REALTIME_URL,
  RealtimeVoiceSession,
  buildVoiceSessionUpdate,
  encodeAudioAppend,
  parseVoiceEvent
} = require('../lib/voice-session');

class FakeSocket {
  static OPEN = 1;

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.handlers = new Map();
    this.sent = [];
    FakeSocket.instance = this;
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  emit(event, value) {
    this.handlers.get(event)?.(value);
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit('open');
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

test('should configure a transcription session without server turn detection', () => {
  const event = buildVoiceSessionUpdate({ delay: 'low', turnDetection: 'semantic-low' });
  assert.equal(event.type, 'session.update');
  assert.equal(event.session.type, 'transcription');
  assert.equal(event.session.audio.input.format.rate, DEFAULT_SAMPLE_RATE);
  assert.equal(event.session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.equal(event.session.audio.input.transcription.delay, 'low');
  assert.equal(event.session.audio.input.turn_detection, null);
  assert.equal(JSON.stringify(event).includes('model=gpt-live-transcribe'), false);
  assert.match(REALTIME_URL, /[?&]intent=transcription/);
  assert.doesNotMatch(REALTIME_URL, /[?&]model=/);
});

test('should encode PCM audio as an append event', () => {
  assert.deepEqual(encodeAudioAppend(Buffer.from([0, 1, 2])), {
    type: 'input_audio_buffer.append',
    audio: 'AAEC'
  });
  assert.equal(encodeAudioAppend(Buffer.alloc(0)), null);
});

test('should open the realtime session and forward transcription events', async () => {
  const events = [];
  const errors = [];
  const session = new RealtimeVoiceSession({
    apiKey: 'sk-test-secret',
    WebSocketImpl: FakeSocket,
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error.message)
  });
  const pending = session.start({ delay: 'minimal', turnDetection: 'server' });
  const socket = FakeSocket.instance;
  assert.equal(socket.url, REALTIME_URL);
  assert.equal(socket.options.headers.authorization, 'Bearer sk-test-secret');
  socket.open();
  await pending;

  assert.equal(socket.sent[0].session.type, 'transcription');
  assert.equal(socket.sent[0].session.audio.input.turn_detection, null);
  assert.equal(session.sendAudio(Buffer.from([1, 2])), true);
  assert.equal(session.commit(), true);
  assert.deepEqual(socket.sent[1], { type: 'input_audio_buffer.append', audio: 'AQI=' });
  assert.deepEqual(socket.sent[2], { type: 'input_audio_buffer.commit' });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello' })));
  assert.equal(events.at(-1).transcript, 'hello');
  assert.deepEqual(errors, []);

  session.stop();
  assert.equal(session.isOpen(), false);
});

test('should surface a server error without exposing the key', () => {
  const errors = [];
  const session = new RealtimeVoiceSession({
    apiKey: 'sk-test-secret',
    WebSocketImpl: FakeSocket,
    onError: (error) => errors.push(error.message)
  });
  const pending = session.start();
  const socket = FakeSocket.instance;
  socket.open();
  return pending.then(() => {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'error', error: { message: 'bad request' } })));
    assert.deepEqual(errors, ['bad request']);
    assert.doesNotMatch(errors[0], /sk-test-secret/);
    session.stop();
  });
});

test('should ignore malformed realtime events', () => {
  assert.equal(parseVoiceEvent('{not json}'), null);
  assert.deepEqual(parseVoiceEvent(JSON.stringify({ type: 'ok' })), { type: 'ok' });
});
