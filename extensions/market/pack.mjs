// 生成 AntiSIT 第三方市场源：market.json + market.json.sig（Ed25519）
//
// 用法（在仓库根目录）：
//   node extensions/market/pack.mjs --zip antiprint-admin-1.0.0.zip --out extensions/market/dist
//
// 私钥默认在 ~/.antiprint-market-key.json（不在仓库里，丢了就无法给老用户发更新，
// 需要重新发源让用户重新添加）。生成的 publicKeySave 与指纹会打印出来，
// 用户在 AntiSIT「市场 → 添加第三方源」时核对指纹。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const zipPath = path.resolve(arg('zip', path.join(here, '..', '..', 'antiprint-admin-1.0.0.zip')));
const outDir = path.resolve(arg('out', path.join(here, 'dist')));
const keyFile = path.resolve(arg('key', path.join(os.homedir(), '.antiprint-market-key.json')));
const extDir = path.resolve(arg('ext', path.join(here, '..', 'antiprint-admin')));

const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'ext.json'), 'utf8'));
const zipBytes = fs.readFileSync(zipPath);
const sha256 = crypto.createHash('sha256').update(zipBytes).digest('hex');

// ── 密钥：没有就生成一次，之后复用（私钥不进仓库）──
let key;
if (fs.existsSync(keyFile)) {
  key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
} else {
  const pair = crypto.generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const publicRaw = Buffer.from(jwk.x, 'base64url');
  key = {
    publicKey: publicRaw.toString('base64'),
    privateKeyJwk: pair.privateKey.export({ format: 'jwk' }),
  };
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 2));
  console.log('已生成新的签名密钥：' + keyFile);
}

const publicRaw = Buffer.from(key.publicKey, 'base64');
const privateKey = crypto.createPrivateKey({ key: key.privateKeyJwk, format: 'jwk' });
const publicKey = crypto.createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: publicRaw.toString('base64url') },
  format: 'jwk',
});

// ── 目录：保留同目录里其他拓展，只替换当前这个 id ──
fs.mkdirSync(outDir, { recursive: true });
const catalogPath = path.join(outDir, 'market.json');
let catalog = { schema: 1, keyId: 'antiprint-market', publicKey: key.publicKey, extensions: [] };
if (fs.existsSync(catalogPath)) {
  try {
    const old = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    if (old && Array.isArray(old.extensions)) {
      catalog.extensions = old.extensions.filter((item) => item && item.id !== manifest.id);
    }
  } catch {
    // 旧目录坏了就重建
  }
}

catalog.extensions.push({
  id: manifest.id,
  name: manifest.name,
  desc: manifest.desc || '',
  author: 'miemieYLF',
  category: '工具',
  icon: '',
  type: 'bundle',
  runtime: 'cordis',
  version: manifest.version || '1.0.0',
  url: '',
  homepage: 'https://github.com/miemiejack8899-source/AntiPrint',
  zip: path.basename(zipPath),
  sha256,
  size: zipBytes.length,
  permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
  minAppVersion: manifest.minAppVersion || '',
});
catalog.extensions.sort((a, b) => String(a.id).localeCompare(String(b.id)));

// 目录必须“先定稿再签名”，签完不能再改一个字节
const catalogBytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n', 'utf8');
fs.writeFileSync(catalogPath, catalogBytes);
fs.copyFileSync(zipPath, path.join(outDir, path.basename(zipPath)));

const signature = crypto.sign(null, catalogBytes, privateKey);
fs.writeFileSync(path.join(outDir, 'market.json.sig'), signature.toString('base64') + '\n');

// 自检：用目录里的公钥验一遍
const ok = crypto.verify(null, catalogBytes, publicKey, signature);
const hex = crypto.createHash('sha256').update(publicRaw).digest('hex').toUpperCase();
const fingerprint = [0, 4, 8].map((start) => hex.slice(start, start + 4)).join('-');

console.log('拓展: ' + manifest.id + ' v' + manifest.version);
console.log('zip: ' + path.basename(zipPath) + '（' + zipBytes.length + ' 字节）');
console.log('sha256: ' + sha256);
console.log('公钥(base64): ' + key.publicKey);
console.log('指纹: ' + fingerprint);
console.log('签名自检: ' + (ok ? '通过' : '失败'));
console.log('输出目录: ' + outDir);
if (!ok) process.exit(1);
