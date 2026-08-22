const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { captureDisplay } = require('../lib/capture');

test('should resize a captured image when a maximum width is configured', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-gpt-capture-test-'));
  const calls = [];
  try {
    const result = await captureDisplay({
      displayNumber: 3,
      maxImageWidth: 2048,
      tempDirectory,
      execFileImpl: async (command, args) => {
        calls.push([command, args]);
        const outputPath = command === 'screencapture' ? args.at(-1) : args.at(-1);
        await fs.writeFile(outputPath, command === 'screencapture' ? 'original' : 'resized');
      }
    });

    assert.equal(result.buffer.toString(), 'resized');
    assert.deepEqual(calls.map(([command]) => command), ['screencapture', 'sips']);
    assert.deepEqual(calls[1][1], [
      '--resampleWidth',
      '2048',
      calls[0][1].at(-1),
      '--out',
      calls[1][1].at(-1)
    ]);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('should use the original image when resizing fails', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-gpt-capture-test-'));
  const warnings = [];
  try {
    const result = await captureDisplay({
      displayNumber: 2,
      maxImageWidth: 1024,
      tempDirectory,
      logger: { warn: (...args) => warnings.push(args) },
      execFileImpl: async (command, args) => {
        if (command === 'screencapture') await fs.writeFile(args.at(-1), 'original');
        else throw new Error('sips unavailable');
      }
    });

    assert.equal(result.buffer.toString(), 'original');
    assert.equal(warnings.length, 1);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
