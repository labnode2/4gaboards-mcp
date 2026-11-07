/** Tiny in-memory stand-in for the 4ga Boards API (test/fake-backend.ts) to try the smoke test offline. */
import { createServer } from 'node:http';
import { fakeBackend } from '../test/fake-backend.js';

const { fetchFn } = fakeBackend();
const port = Number(process.env.FAKE_PORT ?? 18080);
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    void (async () => {
      const body = Buffer.concat(chunks).toString();
      const r = await fetchFn(`http://localhost${req.url}`, { method: req.method, body: body || undefined });
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(await r.text());
    })();
  });
}).listen(port, '127.0.0.1', () => console.log(`fake 4ga API on http://127.0.0.1:${port}`));
