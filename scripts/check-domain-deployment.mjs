import { lookup } from 'node:dns/promises';
import tls from 'node:tls';

const hosts = ['iseedrama.com', 'admin.iseedrama.com', 'media.iseedrama.com', 'www.iseedrama.com'];
let blocked = false;

const report = (label, passed, detail) => {
  console.log(`${passed ? 'PASS' : 'BLOCK'} ${label}${detail ? `: ${detail}` : ''}`);
  blocked ||= !passed;
};

const checkTls = (host) => new Promise((resolve) => {
  const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: true, timeout: 10_000 });
  socket.once('secureConnect', () => {
    const certificate = socket.getPeerCertificate();
    const expiresAt = certificate.valid_to ? new Date(certificate.valid_to) : null;
    const validForDays = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 86_400_000) : null;
    socket.end();
    resolve({ passed: socket.authorized && Boolean(expiresAt && validForDays !== null && validForDays > 0), validForDays });
  });
  socket.once('timeout', () => socket.destroy(new Error('TLS connection timed out')));
  socket.once('error', (error) => resolve({ passed: false, error: error.message }));
});

for (const host of hosts) {
  try {
    const addresses = await lookup(host, { all: true });
    report(`${host} DNS`, addresses.length > 0, addresses.map((item) => item.address).join(', '));
  } catch (error) {
    report(`${host} DNS`, false, error instanceof Error ? error.message : 'lookup failed');
  }

  const tlsResult = await checkTls(host);
  report(`${host} TLS`, tlsResult.passed,
    tlsResult.passed ? `certificate valid for ${tlsResult.validForDays} days` : tlsResult.error || 'certificate is invalid or expired');
}

try {
  const path = '/__domain-check/path';
  const query = '?source=cloudflare&keep=1';
  const response = await fetch(`https://www.iseedrama.com${path}${query}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const location = response.headers.get('location');
  const expected = `https://iseedrama.com${path}${query}`;
  report('www 301 preserves path and query', response.status === 301 && location === expected,
    `HTTP ${response.status}; location=${location || 'missing'}`);
} catch (error) {
  report('www 301 preserves path and query', false, error instanceof Error ? error.message : 'request failed');
}

if (blocked) process.exitCode = 1;
