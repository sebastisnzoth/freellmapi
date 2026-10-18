import {afterEach,it,expect} from 'vitest';
import express from 'express';
import type {Server} from 'node:http';
import {hiveLockdown} from '../../middleware/hiveLockdown.js';
const previous={mode:process.env.FREEAPI_HIVE_LOCKDOWN,token:process.env.FREEAPI_HIVE_TOKEN};
afterEach(()=>{if(previous.mode===undefined)delete process.env.FREEAPI_HIVE_LOCKDOWN;else process.env.FREEAPI_HIVE_LOCKDOWN=previous.mode;if(previous.token===undefined)delete process.env.FREEAPI_HIVE_TOKEN;else process.env.FREEAPI_HIVE_TOKEN=previous.token;});
it('lockdown keeps health minimal and rejects setup, inference and admin even with a valid token',async()=>{
 process.env.FREEAPI_HIVE_LOCKDOWN='true';process.env.FREEAPI_HIVE_TOKEN='dummy-test-token-'.repeat(4);
 const app=express();app.use(hiveLockdown);app.use((_req,res)=>res.json({ok:true}));
 const server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 try{
  expect((await fetch(base+'/api/ping')).status).toBe(200);
  for(const path of ['/','/api/auth/setup','/v1/chat/completions','/api/keys','/api/ping?debug=1']){
   expect((await fetch(base+path)).status).toBe(401);
   const r=await fetch(base+path,{headers:{authorization:'Bearer '+process.env.FREEAPI_HIVE_TOKEN}});
   expect(r.status).toBe(503);expect((await r.json()).code).toBe('HIVE_INFERENCE_NOT_ENABLED');
  }
  delete process.env.FREEAPI_HIVE_TOKEN;expect((await fetch(base+'/api/keys')).status).toBe(503);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
