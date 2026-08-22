const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function captureDisplay({ displayNumber, execFileImpl = execFileAsync, tempDirectory = os.tmpdir() }) {
  const directory = await fs.mkdtemp(path.join(tempDirectory, 'monitor-gpt-'));
  const imagePath = path.join(directory, 'capture.png');
  try {
    await execFileImpl('screencapture', ['-x', '-t', 'png', '-D', String(displayNumber), imagePath]);
    const buffer = await fs.readFile(imagePath);
    if (!buffer.length) throw new Error(`Could not capture display ${displayNumber}: empty image`);
    return { buffer, imagePath, displayNumber };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { captureDisplay };
