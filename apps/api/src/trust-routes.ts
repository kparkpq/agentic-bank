import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { Bank, Trust, type Human } from '@sapiensq/core';
import { LocalChain } from './chain.js';

export function loadAgentKey(directory:string) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const path=join(directory,'agent-key.pem');
  if(!existsSync(path)) writeFileSync(path,generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600,flag:'wx'});
  return createPrivateKey(readFileSync(path));
}
export async function createTrustRoutes(bank:Bank, directory:string, options:{chain?:LocalChain; memoryKey?:ReturnType<typeof createPrivateKey>}={}) {
  const key=options.memoryKey??loadAgentKey(directory);
  // The installation domain survives restarts and prevents cross-installation signature replay.
  const domainFile=join(directory,'domain.txt');
  if(!existsSync(domainFile)){mkdirSync(directory,{recursive:true});writeFileSync(domainFile,randomUUID(),{mode:0o600});}
  const trust=new Trust(bank,key,'sapiensq:'+readFileSync(domainFile,'utf8').trim());
  const chain=options.chain??await LocalChain.open(join(directory,'chain'));
  const app=new Hono<{Variables:{human:Human;token:string}}>();
  const receipts=(human:Human)=>trust.receipts().filter(r=>{
    if(human.role==='operator')return true;
    const p=JSON.parse(r.payload);
    if(p.human_id===human.human_id)return true;
    if(p.request_id){try{return trust.view(p.request_id).body.human_id===human.human_id;}catch{return false;}}
    return false;
  }).map(r=>({...r,payload:JSON.parse(r.payload),anchor:r.anchor_json?JSON.parse(r.anchor_json):null}));
  const anchor=async()=>{try{return await chain.flush(trust);}catch{return {status:'ANCHOR_PENDING',message:'기록은 저장되었습니다. 체인 재시도 또는 검증 결과를 확인하세요.'};}};
  app.onError((e,c)=>c.json({error:e.message},400));
  app.post('/session',async c=>{
    const body=await c.req.json();
    if(typeof body.human_id!=='string' || typeof body.public_key!=='string' || body.public_key.length>256) return c.json({error:'INVALID_LOGIN'},400);
    return c.json(trust.login(body.human_id,body.public_key));
  });
  app.use('*',async(c,next)=>{
    try {
      const token=(c.req.header('Authorization')??'').replace(/^Bearer /,'');
      c.set('human',trust.authenticate(token));c.set('token',token);
    } catch { return c.json({error:'SESSION_REQUIRED_OR_EXPIRED'},401); }
    await next();
  });
  app.post('/logout',c=>{trust.logout(c.get('token'));return c.json({ok:true});});
  app.get('/state',c=>{
    const human=c.get('human');
    const requests=(trust.db.prepare('SELECT id FROM trust_requests ORDER BY rowid DESC LIMIT 100').all() as {id:string}[]).map(r=>trust.view(r.id)).filter(r=>human.role==='operator'||r.body.human_id===human.human_id);
    const grants=trust.db.prepare('SELECT * FROM trust_grants').all().map((r:any)=>({...JSON.parse(r.body),status:r.status})).filter((r:any)=>human.role==='operator'||r.human_id===human.human_id);
    return c.json({human,agents:trust.agents(),grants,requests,receipts:receipts(human),accounts:bank.accounts(human.role,human.customer_id).filter(a=>a.product!=='HOUSE'),network:{mode:'LOCAL_DEVELOPMENT_EVM',chain_id:chain.chainId,contract:chain.address},planner:'EXISTING_RULE_BASED_AGENT',identity_mode:'SANDBOX_SSO_STUB'});
  });
  app.post('/grants/challenge',async c=>c.json(trust.grant(c.get('human'),await c.req.json())));
  app.post('/grants',async c=>{
    const b=await c.req.json();const result=trust.issueGrant(c.get('human'),b.grant_id,b.signature);
    return c.json({result,anchor:await anchor()});
  });
  app.post('/requests',async c=>{
    const b=await c.req.json();const result=trust.propose(c.get('human'),b.grant_id,b.amount);
    return c.json({result,anchor:await anchor()});
  });
  app.post('/requests/:id/approve',async c=>{
    const b=await c.req.json();
    if(typeof b.signature!=='string'||typeof b.approve!=='boolean')return c.json({error:'SIGNATURE_AND_DECISION_REQUIRED'},400);
    const result=trust.execute(c.get('human'),c.req.param('id'),b.signature,b.approve);
    return c.json({result,anchor:await anchor()});
  });
  app.post('/requests/:id/operator-challenge',async c=>{
    const b=await c.req.json();if(typeof b.approve!=='boolean')return c.json({error:'DECISION_REQUIRED'},400);
    return c.json(trust.operatorChallenge(c.get('human'),c.req.param('id'),b.approve));
  });
  app.post('/operator-decision',async c=>{
    const b=await c.req.json();const result=trust.operatorDecision(c.get('human'),b.challenge_id,b.signature);
    return c.json({result,anchor:await anchor()});
  });
  app.post('/revoke',async c=>{
    const b=await c.req.json();if(!['agent','grant'].includes(b.kind)||typeof b.id!=='string')return c.json({error:'INVALID_REVOCATION'},400);
    trust.revoke(c.get('human'),b.kind,b.id);return c.json({ok:true,anchor:await anchor()});
  });
  app.post('/anchor',async c=>{if(c.get('human').role!=='operator')return c.json({error:'OPERATOR_REQUIRED'},403);return c.json(await anchor());});
  app.get('/evidence',c=>c.json({receipts:receipts(c.get('human'))}));
  app.get('/evidence/:id',c=>{
    const row=receipts(c.get('human')).find(r=>r.id===c.req.param('id'));
    return row?c.json(row):c.json({error:'NOT_FOUND'},404);
  });
  app.get('/verify',async c=>{
    try{return c.json(await chain.verify(trust));}
    catch{return c.json({valid:false,chain_verified:false,reason:'CHAIN_UNAVAILABLE_OR_INVALID'});}
  });
  // Recover evidence written before a previous process stopped, including mined receipts.
  await anchor();
  return {app,trust,chain};
}
