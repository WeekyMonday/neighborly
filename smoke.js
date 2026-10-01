// Temporary smoke test — verifies the server boots and serves the app.
const { spawn } = require('child_process');
const http = require('http');

const PORT = process.env.PORT || 3001;
const child = spawn(process.execPath, ['BACKEND/server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
child.stdout.on('data', (d) => (serverOut += d));
child.stderr.on('data', (d) => (serverOut += d));

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject)
      .on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

const CHECKS = ['/api', '/login.html', '/register.html', '/Neighborly.html', '/sw.js', '/js/app.js'];

(async () => {
  await new Promise((r) => setTimeout(r, 3000));
  let failures = 0;
  for (const path of CHECKS) {
    try {
      const { status, body } = await get(path);
      const ok = status === 200;
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${path} -> ${status} (${body.length} bytes)`);
      if (path === '/sw.js') {
        const m = body.match(/CACHE_NAME = '([^']+)'/);
        console.log(`     service worker cache: ${m ? m[1] : 'NOT FOUND'}`);
      }
    } catch (err) {
      failures++;
      console.log(`FAIL ${path} -> ${err.message}`);
    }
  }
  if (failures) console.log('\n--- server output ---\n' + serverOut);
  child.kill();
  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'All checks passed'}`);
  process.exit(failures ? 1 : 0);
})();