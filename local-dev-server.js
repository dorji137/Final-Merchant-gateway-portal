require('dotenv').config();
const http = require('http');
const handler = require('./api/index');

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    console.error('[local-dev-server] unhandled error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(err?.stack || err?.message || 'Server error');
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[local-dev-server] ERROR: Port ${PORT} is already in use.`);
    console.error(`  Stop the other process or run:  $env:PORT=3002; npm run dev\n`);
  } else {
    console.error('[local-dev-server] Server error:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\n✅ Cardzone backend running`);
  console.log(`   Checkout UI  : http://localhost:${PORT}/`);
  console.log(`   Health check : http://localhost:${PORT}/health`);
  console.log(`   Debug TXN    : http://localhost:${PORT}/api/tx/<txnId>`);
  console.log(`\n⚠️  For Cardzone callbacks set: $env:CALLBACK_BASE_URL="https://your-ngrok.ngrok.io"\n`);
});
