const { createServer } = require('node:http');
const { lstatSync, readFileSync, writeFileSync } = require('node:fs');
const [output, behavior, ...args] = process.argv.slice(2);
const path = args[args.indexOf('--api-key-file') + 1];
const stat = lstatSync(path);
const token = readFileSync(path, 'utf8');
writeFileSync(output, JSON.stringify({
  args, path, mode: stat.mode & 0o777, regular: stat.isFile(), token,
  envKey: process.env.ATOMIC_AGENT_API_KEY ?? null,
}));
if (behavior === 'fail') process.exit(3);
if (behavior === 'hang') {
  setInterval(() => {}, 1000);
} else {
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
