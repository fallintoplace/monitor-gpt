const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function captureDisplay({
  displayNumber,
  maxImageWidth = 0,
  execFileImpl = execFileAsync,
  tempDirectory = os.tmpdir(),
  logger = console
}) {
  const directory = await fs.mkdtemp(path.join(tempDirectory, 'monitor-gpt-'));
  const imagePath = path.join(directory, 'capture.png');
  try {
    await execFileImpl('screencapture', ['-x', '-t', 'png', '-D', String(displayNumber), imagePath]);
    let outputPath = imagePath;
    const requestedWidth = Number(maxImageWidth);
    if (Number.isFinite(requestedWidth) && requestedWidth > 0) {
      const resizedPath = path.join(directory, 'capture-resized.png');
      try {
        await execFileImpl('sips', [
          '--resampleWidth',
          String(Math.round(requestedWidth)),
          imagePath,
          '--out',
          resizedPath
        ]);
        await fs.access(resizedPath);
        outputPath = resizedPath;
      } catch (error) {
        logger.warn?.(`Could not resize display ${displayNumber} capture; using the original image:`, error.message);
      }
    }
    const buffer = await fs.readFile(outputPath);
    if (!buffer.length) throw new Error(`Could not capture display ${displayNumber}: empty image`);
    return { buffer, imagePath: outputPath, displayNumber };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { captureDisplay };
