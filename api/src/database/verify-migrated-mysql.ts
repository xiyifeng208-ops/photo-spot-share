import { loadConfig } from '../config/configuration';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { DatabaseService } from './database.service';
import { StorageService } from '../storage/storage.service';
import { SpotsService } from '../spots/spots.service';

async function main() {
  const remote=process.argv.includes('--remote');
  let value=process.env.MYSQL_REHEARSAL_URL;
  if (remote) {
    const env=parse(readFileSync(resolve(process.cwd(),'.env.mysql-check')));
    if (env.MYSQL_DATABASE!=='photo_spot_share' || !env.MYSQL_HOST || !env.MYSQL_PORT || !env.MYSQL_USER || !env.MYSQL_PASSWORD) throw new Error('remote private configuration invalid');
    const remoteUrl=new URL('mysql://localhost');
    remoteUrl.hostname=env.MYSQL_HOST; remoteUrl.port=env.MYSQL_PORT; remoteUrl.username=env.MYSQL_USER;
    remoteUrl.password=env.MYSQL_PASSWORD; remoteUrl.pathname='/'+env.MYSQL_DATABASE;
    value=remoteUrl.toString();
  }
  if (!value) throw new Error('MYSQL_REHEARSAL_URL is required');
  const url = new URL(value);
  if (!remote && (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !url.pathname.endsWith('_rehearsal'))) throw new Error('local *_rehearsal database required');
  const config = loadConfig({ NODE_ENV:remote?'development':'test', DATABASE_URL:value, DATABASE_SSL:'false',
    DATABASE_ALLOW_INSECURE_REMOTE:remote?'true':'false', PUBLIC_BASE_URL:'http://localhost:3000' });
  const db = new DatabaseService(config);
  const storage = new StorageService(config);
  const service = new SpotsService(db, storage, {} as never, {} as never, {} as never, {} as never);
  try {
    await db.onModuleInit();
    const feed = await service.findFeed({ limitRaw:'100' });
    const map = await service.findInView({ bboxRaw:'73,18,135,54', zoomRaw:'14', limitRaw:'100' });
    const clusters = await service.findInView({ bboxRaw:'73,18,135,54', zoomRaw:'6', limitRaw:'100' });
    const users = await db.query<{id:string}>('SELECT id FROM users ORDER BY id');
    const mineCounts: Record<string,number> = {};
    for (const user of users.rows) mineCounts[user.id] = (await service.findMine(user.id, undefined, '100')).items.length;
    const associationCounts = await db.queryOne<{best_times:number;best_seasons:number}>(`SELECT
      (SELECT COUNT(*) FROM spot_best_times) best_times,
      (SELECT COUNT(*) FROM spot_best_seasons) best_seasons`);
    if (feed.items.length !== 6 || map.items.length !== 6 || clusters.clusters.length === 0 || !associationCounts || Number(associationCounts.best_times)!==12 || Number(associationCounts.best_seasons)!==18) throw new Error('backend read verification mismatch');
    console.log(JSON.stringify({backendRead:true,mode:remote?'remote':'rehearsal',feedItems:feed.items.length,mineCounts,
      mapItems:map.items.length, clusterGroups:clusters.clusters.length,
      bestTimes:Number(associationCounts.best_times),bestSeasons:Number(associationCounts.best_seasons),
      allCreatedAtUtc:feed.items.every(item=>item.createdAt.endsWith('Z'))},null,2));
  } finally { await db.onModuleDestroy(); }
}
main().catch(error=>{console.error((error as Error).message);process.exitCode=1;});
