// Docker HEALTHCHECK probe. Exits 0 if the watcher's /health says ok, else 1.
const http = require('http');
const port = process.env.HEALTH_PORT || 8080;
const req = http.get('http://127.0.0.1:' + port + '/health', r => {
  process.exit(r.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.setTimeout(8000, () => { req.destroy(); process.exit(1); });
