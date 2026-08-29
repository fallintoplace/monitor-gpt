const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

function writeJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(body);
}

function readBody(request, maximumBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumBytes) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function safePublicPath(publicDirectory, requestPath) {
  const relative = requestPath === '/'
    ? 'index.html'
    : requestPath === '/result'
      ? 'result.html'
      : requestPath === '/voice'
        ? 'voice.html'
      : requestPath.replace(/^\/+/, '');
  const resolved = path.resolve(publicDirectory, relative);
  if (resolved !== publicDirectory && !resolved.startsWith(`${publicDirectory}${path.sep}`)) return null;
  return resolved;
}

function createLocalServer({ runner, publicDirectory, memory }) {
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;

      if (pathname === '/api/state' && request.method === 'GET') {
        writeJson(response, 200, runner.snapshot());
        return;
      }

      if (pathname === '/api/displays' && request.method === 'GET') {
        writeJson(response, 200, { displays: runner.snapshot().displays });
        return;
      }

      if (pathname === '/api/settings' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request));
        const settings = runner.updateSettings(body);
        writeJson(response, 200, { settings });
        return;
      }

      if (pathname === '/api/analyze' && request.method === 'POST') {
        let body = {};
        const raw = await readBody(request, 256 * 1024);
        if (raw.trim()) body = JSON.parse(raw);
        void runner.triggerAnalysis({ reason: body.reason || 'button', promptOverride: body.promptOverride || '' });
        writeJson(response, 202, { accepted: true });
        return;
      }

      if (pathname === '/api/start' && request.method === 'POST') {
        runner.start();
        writeJson(response, 200, { monitoring: true });
        return;
      }

      if (pathname === '/api/stop' && request.method === 'POST') {
        runner.stop();
        writeJson(response, 200, { monitoring: false });
        return;
      }

      if (pathname === '/api/memory' && request.method === 'GET') {
        writeJson(response, 200, memory.summary());
        return;
      }

      if (pathname === '/api/memory/clear' && request.method === 'POST') {
        runner.clearMemory();
        writeJson(response, 200, { cleared: true });
        return;
      }

      if (pathname === '/api/memory/delete' && request.method === 'POST') {
        const body = JSON.parse(await readBody(request, 32 * 1024));
        writeJson(response, 200, { deleted: runner.deleteMemoryEntry(body.id) });
        return;
      }

      if (pathname === '/api/memory/image' && request.method === 'GET') {
        const imagePath = memory.getLatestImagePath();
        if (!imagePath) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          response.end('No screenshot saved');
          return;
        }
        response.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-store'
        });
        fs.createReadStream(imagePath).pipe(response);
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        writeJson(response, 404, { error: 'Not found' });
        return;
      }

      const filePath = safePublicPath(publicDirectory, pathname);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      const extension = path.extname(filePath).toLowerCase();
      response.writeHead(200, {
        'content-type': MIME_TYPES[extension] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      if (request.method === 'HEAD') {
        response.end();
      } else {
        fs.createReadStream(filePath).pipe(response);
      }
    } catch (error) {
      writeJson(response, 400, { error: error.message || 'Bad request' });
    }
  });
  return server;
}

function listen(server, requestedPort = 4317) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const onError = (error) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && port < requestedPort + 20) {
          tryPort(port + 1);
        } else {
          reject(error);
        }
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    const port = requestedPort === undefined ? 4317 : Number(requestedPort);
    tryPort(Number.isFinite(port) ? port : 4317);
  });
}

module.exports = { createLocalServer, listen, readBody, safePublicPath };
