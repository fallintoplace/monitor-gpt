const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResponsesPayload, extractResponseText, requestOpenAI } = require('../lib/openai');

test('should build an image Responses request with low-priority memory', () => {
  const payload = buildResponsesPayload({
    settings: { model: 'gpt-5.6-luna', reasoning: 'medium', imageDetail: 'auto' },
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
});

test('should extract text from Responses output items', () => {
  assert.equal(extractResponseText({ output_text: ' direct ' }), 'direct');
  assert.equal(extractResponseText({ output: [{ content: [{ type: 'output_text', text: 'hello' }] }] }), 'hello');
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
