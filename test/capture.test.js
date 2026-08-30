const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { captureDisplay } = require('../lib/capture');

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 4, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

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

test('should not upscale a screenshot below the configured maximum width', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-gpt-capture-test-'));
  const calls = [];
  const original = pngHeader(1024, 768);
  try {
    const result = await captureDisplay({
      displayNumber: 1,
      maxImageWidth: 2048,
      tempDirectory,
      execFileImpl: async (command, args) => {
        calls.push([command, args]);
        await fs.writeFile(args.at(-1), original);
      }
    });

    assert.deepEqual(calls.map(([command]) => command), ['screencapture']);
    assert.deepEqual(result.buffer, original);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('should capture the requested display by stable display id', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-gpt-capture-test-'));
  const expected = pngHeader(1920, 1080);
  const calls = [];
  try {
    const result = await captureDisplay({
      displayId: 'display-2',
      displayNumber: 1,
      displayWidth: 1920,
      displayHeight: 1080,
      scaleFactor: 1,
      maxImageWidth: 2048,
      tempDirectory,
      desktopCapturerImpl: {
        getSources: async (options) => {
          assert.deepEqual(options.thumbnailSize, { width: 1920, height: 1080 });
          return [
            { display_id: 'display-1', thumbnail: { toPNG: () => Buffer.from('wrong') } },
            { display_id: 'display-2', thumbnail: { toPNG: () => expected } }
          ];
        }
      },
      execFileImpl: async (command, args) => calls.push([command, args])
    });

    assert.deepEqual(result.buffer, expected);
    assert.equal(result.displayId, 'display-2');
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
