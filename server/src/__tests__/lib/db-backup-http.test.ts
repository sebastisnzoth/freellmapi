import {afterEach,describe,it,expect,vi} from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {backupDbNow,restoreDbBackupIfNeeded} from '../../lib/db-backup.js';

const names=['ENCRYPTION_KEY','FREEAPI_DB_BACKUP_KEY','FREEAPI_DB_BACKUP_URL','FREEAPI_DB_BACKUP_PATH','FREEAPI_DB_BACKUP_TARGET','FREEAPI_DB_BACKUP_TOKEN','FREEAPI_DB_BACKUP_STRICT'];
const original=Object.fromEntries(names.map(k=>[k,process.env[k]]));
afterEach(()=>{for(const k of names){if(original[k]===undefined)delete process.env[k];else process.env[k]=original[k];}vi.unstubAllGlobals();});
describe('real encrypted HTTP backup recovery',()=>{
 it('survives local file deletion and receiver restart; includes committed WAL with an active reader',async()=>{
  for(const k of names)delete process.env[k];
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'freeapi-http-'));
  process.env.ENCRYPTION_KEY='a'.repeat(64);process.env.FREEAPI_DB_BACKUP_KEY='b'.repeat(64);
  process.env.FREEAPI_DB_BACKUP_TOKEN='dummy-only';
  const dbPath=path.join(dir,'db.sqlite');const stored=path.join(dir,'remote.enc');
  let db=new Database(dbPath);db.pragma('journal_mode=WAL');db.exec("create table items(name text);insert into items values('initial')");
  let version='"00000000-0000-4000-8000-000000000001"';
  let fail=0;
  const server=http.createServer(async(req,res)=>{
   if(req.headers.authorization!=='Bearer dummy-only'){res.writeHead(401).end();return;}
   if(fail){res.writeHead(fail).end();return;}
   if(req.method==='GET'){res.writeHead(200,{etag:version});res.end(fs.readFileSync(stored));return;}
   if(req.headers['if-match'] && req.headers['if-match']!==version){res.writeHead(412).end();return;}
   const chunks:Buffer[]=[];for await(const b of req)chunks.push(b);fs.writeFileSync(stored,Buffer.concat(chunks));
   version='"'+crypto.randomUUID()+'"';res.writeHead(204,{etag:version}).end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  try{
   process.env.FREEAPI_DB_BACKUP_PATH=stored;await backupDbNow(db,dbPath);delete process.env.FREEAPI_DB_BACKUP_PATH;
   process.env.FREEAPI_DB_BACKUP_URL=`http://127.0.0.1:${address.port}/snapshot`;
   db.close();fs.rmSync(dbPath);
   expect((await restoreDbBackupIfNeeded(dbPath)).restored).toBe(true);
   db=new Database(dbPath);db.pragma('journal_mode=WAL');
   const reader=new Database(dbPath);reader.exec('BEGIN');reader.prepare('select * from items').all();
   db.exec("insert into items values('wal-survived')");
   await backupDbNow(db,dbPath);await backupDbNow(db,dbPath);reader.exec('ROLLBACK');reader.close();db.close();
   fs.rmSync(dbPath);await restoreDbBackupIfNeeded(dbPath);db=new Database(dbPath);
   expect(db.prepare('select count(*) as n from items').get()).toEqual({n:2});
   db.close();fs.rmSync(dbPath);
   process.env.FREEAPI_DB_BACKUP_KEY='c'.repeat(64);
   await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/could not restore/);expect(fs.existsSync(dbPath)).toBe(false);
   process.env.FREEAPI_DB_BACKUP_KEY='b'.repeat(64);
   const valid=fs.readFileSync(stored);const corrupted=Buffer.from(valid);corrupted[corrupted.length-1]^=1;fs.writeFileSync(stored,corrupted);
   await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/could not restore/);expect(fs.existsSync(dbPath)).toBe(false);fs.writeFileSync(stored,valid);
   for(const status of [401,429,500,404]){fail=status;if(status===404)process.env.FREEAPI_DB_BACKUP_STRICT='false';
    if(status===404)expect((await restoreDbBackupIfNeeded(dbPath)).skipped).toBe('no backup found');
    else await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow('HTTP '+status);
   }
   fail=0;process.env.FREEAPI_DB_BACKUP_STRICT='true';await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/requires HTTPS/);
  }finally{try{db.close();}catch{}await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(dir,{recursive:true,force:true});}
 });
 it('strict mode refuses missing ETags, redirects and empty remote backups over HTTPS',async()=>{
  for(const k of names)delete process.env[k];process.env.ENCRYPTION_KEY='a'.repeat(64);process.env.FREEAPI_DB_BACKUP_TOKEN='dummy-only';
  process.env.FREEAPI_DB_BACKUP_URL='https://test.example/snapshot';process.env.FREEAPI_DB_BACKUP_STRICT='true';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'freeapi-strict-'));const dbPath=path.join(dir,'db');
  try{
   vi.stubGlobal('fetch',vi.fn(async()=>new Response('test')));await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/ETag/);
   vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{headers:{etag:'"00000000-0000-4000-8000-000000000001"'}})));await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/empty remote/);
   fs.writeFileSync(dbPath,'');await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/EMPTY_DATABASE_PLACEHOLDER/);fs.rmSync(dbPath);
   vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:404})));await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/existing provisioned/);
   vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{expect(opts.redirect).toBe('error');throw new Error('redirect rejected');}));await expect(restoreDbBackupIfNeeded(dbPath)).rejects.toThrow(/redirect/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 });
});
