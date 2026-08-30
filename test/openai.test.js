const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResponsesPayload, buildVoiceAnswerPayload, extractResponseText, requestOpenAI } = require('../lib/openai');

test('should build an image Responses request with low-priority memory', () => {
  const payload = buildResponsesPayload({
    settings: { model: 'gpt-5.6-luna', reasoning: 'medium', imageDetail: 'auto', screenAnswerLanguage: 'Spanish' },
    prompt: 'Analyze this screen.',
    imageBase64: 'abc123',
    memoryContext: 'LOW-PRIORITY LOCAL MEMORY. Earlier answer.'
  });
  assert.equal(payload.model, 'gpt-5.6-luna');
  assert.deepEqual(payload.reasoning, { effort: 'medium' });
  assert.equal(payload.store, false);
  assert.equal(payload.input[0].content[1].type, 'input_text');
  assert.equal(payload.input[0].content[2].image_url, 'data:image/png;base64,abc123');
  assert.equal(payload.input[0].content[2].detail, undefined);
  assert.match(payload.instructions, /Answer in Spanish only/);
});

test('should extract text from Responses output items', () => {
  assert.equal(extractResponseText({ output_text: ' direct ' }), 'direct');
  assert.equal(extractResponseText({ output: [{ content: [{ type: 'output_text', text: 'hello' }] }] }), 'hello');
});

test('should build a separate text-only voice answer request', () => {
  const payload = buildVoiceAnswerPayload({
    settings: { model: 'gpt-5.6-luna', voiceModel: 'gpt-5.6-sol', reasoning: 'medium', voicePrompt: 'Keep it short.', voiceAnswerLanguage: 'Vietnamese' },
    transcript: 'What is a mutex?'
  });

  assert.equal(payload.model, 'gpt-5.6-sol');
  assert.deepEqual(payload.reasoning, { effort: 'medium' });
  assert.equal(payload.store, false);
  assert.match(payload.input[0].content[0].text, /What is a mutex\?/);
  assert.equal(payload.input[0].content.some((part) => part.type === 'input_image'), false);
  assert.match(payload.instructions, /Keep it short/);
  assert.match(payload.instructions, /Answer in Vietnamese only/);

  const customPayload = buildVoiceAnswerPayload({
    settings: { model: 'gpt-5.6-luna', voiceModel: 'custom', voiceCustomModel: 'voice-model-123' },
    transcript: 'What is a mutex?'
  });
  assert.equal(customPayload.model, 'voice-model-123');
});

test('should put low-priority voice memory before the current question', () => {
  const payload = buildVoiceAnswerPayload({
    settings: { voiceModel: 'gpt-5.6-luna', reasoning: 'medium', voiceAnswerLanguage: 'English' },
    transcript: 'What is CORS?',
    memoryContext: 'LOW-PRIORITY VOICE MEMORY. Earlier question: What is HTTP?'
  });

  assert.equal(payload.input[0].content.length, 2);
  assert.match(payload.input[0].content[0].text, /LOW-PRIORITY VOICE MEMORY/);
  assert.match(payload.input[0].content[1].text, /What is CORS/);
  assert.equal(payload.input[0].content.some((part) => part.type === 'input_image'), false);
  assert.match(payload.instructions, /low-priority reference only/);
});

test('should never include the API key in a request error', async () => {
  const secret = 'sk-test-secret-value';
  await assert.rejects(
    requestOpenAI({
      apiKey: secret,
      payload: {},
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'invalid key' } })
      })
    }),
    /OpenAI request failed \(401\): invalid key/
  );
});

test('should abort a request that exceeds the timeout', async () => {
  await assert.rejects(
    requestOpenAI({
      apiKey: 'sk-test-secret-value',
      payload: {},
      timeoutMs: 10,
      fetchImpl: (_endpoint, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      })
    }),
    /OpenAI request timed out after 1 seconds\./
  );
});
