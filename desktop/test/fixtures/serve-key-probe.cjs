const { createServer } = require('node:http');
const { readFileSync, writeFileSync } = require('node:fs');
const [output, behavior, ...args] = process.argv.slice(2);
if (behavior === 'old') {
  process.stderr.write('serve: unknown flag: --api-key-stdin');
  process.exitCode = 2;
} else {
  const input = args.includes('--api-key-stdin') ? readFileSync(0, 'utf8') : '';
  const token = input.trimEnd();
  writeFileSync(output, JSON.stringify({
    args, input, token, envKey: process.env.ATOMIC_AGENT_API_KEY ?? null,
  }));
  createServer((req, res) => {
    if (req.url === '/health') return res.end('{}');
    if (req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401);
      return res.end();
    }
    if (req.url === '/api/events') return res.writeHead(200).end(': keepalive\n\n');
    res.end(JSON.stringify({ authenticated: true }));
  }).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
}
