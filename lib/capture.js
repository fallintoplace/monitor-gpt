const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngWidth(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  return width > 0 ? width : null;
}

async function captureWithDesktopCapturer({ desktopCapturerImpl, displayId, displayWidth, displayHeight, scaleFactor }) {
  const width = Math.max(1, Math.round((Number(displayWidth) || 1920) * (Number(scaleFactor) || 1)));
  const height = Math.max(1, Math.round((Number(displayHeight) || 1080) * (Number(scaleFactor) || 1)));
  const sources = await desktopCapturerImpl.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  });
  const source = sources.find((candidate) => String(candidate.display_id || '') === String(displayId));
  if (!source) throw new Error(`Could not find screen capture source for display ${displayId}. Refresh the display list.`);
  if (!source.thumbnail?.toPNG) throw new Error(`Display ${displayId} did not provide a screenshot.`);
  const buffer = source.thumbnail.toPNG();
  if (!buffer?.length) throw new Error(`Could not capture display ${displayId}: empty image`);
  return buffer;
}

async function captureDisplay({
  displayId = '',
  displayNumber,
  displayWidth,
  displayHeight,
  scaleFactor,
  maxImageWidth = 0,
  desktopCapturerImpl = null,
  execFileImpl = execFileAsync,
  tempDirectory = os.tmpdir(),
  logger = console
}) {
  const directory = await fs.mkdtemp(path.join(tempDirectory, 'monitor-gpt-'));
  const imagePath = path.join(directory, 'capture.png');
  try {
    let originalBuffer;
    if (desktopCapturerImpl?.getSources && displayId) {
      originalBuffer = await captureWithDesktopCapturer({
        desktopCapturerImpl,
        displayId,
        displayWidth,
        displayHeight,
        scaleFactor
      });
      await fs.writeFile(imagePath, originalBuffer);
    } else {
      await execFileImpl('screencapture', ['-x', '-t', 'png', '-D', String(displayNumber), imagePath]);
      originalBuffer = await fs.readFile(imagePath);
    }
    let outputPath = imagePath;
    const requestedWidth = Number(maxImageWidth);
    if (Number.isFinite(requestedWidth) && requestedWidth > 0
      && (pngWidth(originalBuffer) === null || pngWidth(originalBuffer) > requestedWidth)) {
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
    return { buffer, displayId: String(displayId || ''), displayNumber };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { captureDisplay, pngWidth };
