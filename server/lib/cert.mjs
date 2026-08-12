import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function ensureCert(dir) {
  const keyPath = path.join(dir, 'localhost-key.pem');
  const certPath = path.join(dir, 'localhost-cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), created: false, certPath };
  }

  fs.mkdirSync(dir, { recursive: true });
  const conf = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(conf, [
    '[req]', 'distinguished_name = dn', 'x509_extensions = ext', 'prompt = no',
    '[dn]', 'CN = localhost',
    '[ext]', 'subjectAltName = DNS:localhost, IP:127.0.0.1, IP:::1', 'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment', 'extendedKeyUsage = serverAuth',
  ].join('\n'));

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-days', '3650', '-keyout', keyPath, '-out', certPath, '-config', conf,
  ], { stdio: 'pipe' });
  fs.unlinkSync(conf);
  fs.chmodSync(keyPath, 0o600);

  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), created: true, certPath };
}
