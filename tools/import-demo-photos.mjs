#!/usr/bin/env node
// 把一组照片导入成演示机位的样张：写 photos 记录、设封面、确保机位是 active。
//
//   node tools/import-demo-photos.mjs                       # 默认读 work/demo-photos
//   node tools/import-demo-photos.mjs --dir work/my-photos
//   node tools/import-demo-photos.mjs --database postgres://spot@127.0.0.1:55432/spot
//
// 照片按文件名排序，依次分配给演示机位（外滩 / 武康大楼 / 西湖 / 李子坝 / 陆家嘴 / 洱海）。
// 也可以在目录里放 mapping.json 指定对应关系：{ "我的照片.jpg": "外滩" }
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_ROOT = resolve(ROOT, '..', '..');
const require_ = createRequire(join(ROOT, 'api', 'package.json'));
const { Client } = require_('pg');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const photoDir = resolve(CHAT_ROOT, argOf('--dir', 'work/demo-photos'));
const databaseUrl = argOf('--database', process.env.DEMO_DATABASE_URL ?? 'postgres://spot@127.0.0.1:55432/spot');
// 静态根是 api/var/uploads，而对象 key 是 uploads/demo/xxx，所以实际落盘要多一层 uploads
const uploadDir = join(ROOT, 'api', 'var', 'uploads', 'uploads', 'demo');

if (!existsSync(photoDir)) {
  console.error(`照片目录不存在：${photoDir}`);
  console.error('先跑 python tools/gen_demo_photos.py 生成示例样张，或把你的照片放进去。');
  process.exit(1);
}

const images = readdirSync(photoDir)
  .filter((n) => /\.(jpe?g|png|webp)$/i.test(n))
  .sort();
if (!images.length) {
  console.error(`目录里没有图片：${photoDir}`);
  process.exit(1);
}

// 演示机位按创建顺序排列，照片按文件名排序后一一对应
const client = new Client({ connectionString: databaseUrl });
await client.connect();

const spots = (
  await client.query(
    `SELECT id, title FROM spots
      WHERE status <> 'deleted'
      ORDER BY created_at ASC
      LIMIT 20`,
  )
).rows;
if (!spots.length) {
  console.error('数据库里没有机位，先执行 pnpm seed');
  process.exit(1);
}

const mappingPath = join(photoDir, 'mapping.json');
const mapping = existsSync(mappingPath) ? JSON.parse(readFileSync(mappingPath, 'utf8')) : {};

const pickSpot = (fileName, index) => {
  const wanted = mapping[fileName];
  if (wanted) {
    const hit = spots.find((s) => s.title.includes(wanted) || s.id === wanted);
    if (hit) return hit;
    console.warn(`  mapping.json 里的 "${wanted}" 没匹配到机位，按顺序分配`);
  }
  // 文件名形如 01-外滩.jpg：用关键词匹配机位标题（比按顺序分配稳，种子数据的 created_at 是同一时刻）
  const keyword = /^\d+[-_]?(.+)$/.exec(fileName.replace(/\.[^.]+$/, ''))?.[1];
  if (keyword) {
    const hit = spots.find((s) => s.title.includes(keyword));
    if (hit) return hit;
  }
  return spots[index % spots.length];
};

mkdirSync(uploadDir, { recursive: true });

const author = (await client.query(`SELECT id FROM users ORDER BY created_at LIMIT 1`)).rows[0];
if (!author) {
  console.error('数据库里没有用户，先执行 pnpm seed');
  process.exit(1);
}

let imported = 0;
for (const [index, fileName] of images.entries()) {
  const spot = pickSpot(fileName, index);
  const ext = extname(fileName).toLowerCase() || '.jpg';
  const key = `uploads/demo/${spot.id}-${index + 1}${ext}`;
  copyFileSync(join(photoDir, fileName), join(uploadDir, `${spot.id}-${index + 1}${ext}`));

  const size = statSync(join(photoDir, fileName)).size;
  const { rows } = await client.query(
    `INSERT INTO photos (spot_id, user_id, object_key, mime, size_bytes, sort_order)
     VALUES ($1, $2, $3, $4, $5, 0)
     RETURNING id`,
    [spot.id, author.id, key, ext === '.png' ? 'image/png' : 'image/jpeg', size],
  );
  await client.query(`UPDATE spots SET cover_photo_id = $2, status = 'active', updated_at = now() WHERE id = $1`, [
    spot.id,
    rows[0].id,
  ]);
  console.log(`  ${fileName} → ${spot.title}`);
  imported += 1;
}

console.log(`\n完成：导入 ${imported} 张样张，覆盖 ${new Set(images.map((f, i) => pickSpot(f, i).id)).size} 个机位`);
console.log('存储位置：api/var/uploads/demo/（本地存储驱动）');

await client.end();
