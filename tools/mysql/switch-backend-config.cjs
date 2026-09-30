const { createHash } = require('node:crypto');
const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parse } = require('../../api/node_modules/dotenv');

const root = resolve(__dirname, '../..');
const apiDir = resolve(root, 'api');
const envPath = resolve(apiDir, '.env');
const privatePath = resolve(apiDir, '.env.mysql-check');
const original = readFileSync(envPath, 'utf8');
const remote = parse(readFileSync(privatePath, 'utf8'));

for (const key of ['MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
  if (!remote[key]) throw new Error(`Missing ${key} in .env.mysql-check`);
}
if (remote.MYSQL_DATABASE !== 'photo_spot_share') {
  throw new Error('Refusing to switch: unexpected remote database name');
}

const databaseUrl = new URL('mysql://localhost');
databaseUrl.hostname = remote.MYSQL_HOST;
databaseUrl.port = remote.MYSQL_PORT;
databaseUrl.username = remote.MYSQL_USER;
databaseUrl.password = remote.MYSQL_PASSWORD;
databaseUrl.pathname = `/${remote.MYSQL_DATABASE}`;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = resolve(root, 'work', 'backups', `config-before-mysql-${stamp}`);
mkdirSync(backupDir, { recursive: true });
const backupPath = resolve(backupDir, '.env');
copyFileSync(envPath, backupPath);

const replacements = {
  DATABASE_URL: databaseUrl.toString(),
  DATABASE_SSL: 'false',
  DATABASE_ALLOW_INSECURE_REMOTE: 'true',
  DATABASE_POOL_MAX: remote.DATABASE_POOL_MAX || '3',
};

let updated = original;
for (const [key, value] of Object.entries(replacements)) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(updated)) updated = updated.replace(pattern, `${key}=${value}`);
  else updated = `${updated.replace(/\s*$/, '')}\r\n${key}=${value}\r\n`;
}
writeFileSync(envPath, updated, 'utf8');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const reloaded = parse(readFileSync(envPath, 'utf8'));
const parsedUrl = new URL(reloaded.DATABASE_URL);
if (parsedUrl.protocol !== 'mysql:' || parsedUrl.hostname !== remote.MYSQL_HOST || parsedUrl.pathname !== `/${remote.MYSQL_DATABASE}`) {
  throw new Error('Post-write verification failed');
}

console.log(JSON.stringify({
  switched: true,
  driver: 'mysql',
  host: parsedUrl.hostname,
  port: parsedUrl.port,
  database: parsedUrl.pathname.slice(1),
  ssl: reloaded.DATABASE_SSL,
  insecureRemoteAccepted: reloaded.DATABASE_ALLOW_INSECURE_REMOTE,
  poolMax: reloaded.DATABASE_POOL_MAX,
  backupPath,
  backupSha256: sha256(original),
  currentEnvSha256: sha256(updated),
}, null, 2));
