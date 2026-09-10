import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Contract } from 'ethers';
import { Hono } from 'hono';
import { moneyGate } from './money-gate.js';
import { Bank, canonical, hash } from '@sapiensq/core';
import { LocalChain } from './chain.js';
import { createTrustRoutes } from './trust-routes.js';

const dir=mkdtempSync(join(tmpdir(),'sapiensq-trust-'));
const bank=new Bank();bank.seed();
let runtime:Awaited<ReturnType<typeof createTrustRoutes>>|undefined;
let checks=0;
function ok(condition:unknown,message:string){assert.ok(condition,message);checks++;}
try {
  runtime=await createTrustRoutes(bank,dir,{memoryKey:generateKeyPairSync('ed25519').privateKey});
  const {app,trust}=runtime;
  const guarded=new Hono();
  guarded.use('/api/*',moneyGate(bank));
  guarded.all('*',c=>c.json({executed:true}));
  for(const [path,body] of [
    ['/api/tools',{action:'transfer'}],
    ['/api/proposals/treasury-idle/execute',{}],
    ['/api/operator/approve',{}],
    ['/api/operator/deny',{}],
  ] as const){
    const denied=await guarded.request('http://localhost'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    ok(denied.status===428,'unsigned legacy money endpoint blocked: '+path);
  }

  let chain=runtime.chain;
  const pair=await webcrypto.subtle.generateKey('Ed25519',false,['sign','verify']) as webcrypto.CryptoKeyPair;
  const public_key=Buffer.from(await webcrypto.subtle.exportKey('spki',pair.publicKey)).toString('base64');
  const sign=async(message:string)=>Buffer.from(await webcrypto.subtle.sign('Ed25519',pair.privateKey,new TextEncoder().encode(message))).toString('base64');
  let token='';
  async function call(path:string,body?:unknown,auth=token){
    const res=await app.request('http://localhost'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json() as any};
  }
  ok((await call('/state')).status===401,'no auth rejected');
  token=(await call('/session',{human_id:'syn_alice',public_key})).body.token;
  ok(!!token,'sandbox session bound to browser public key');
  const challenge=(await call('/grants/challenge',{max_amount:1000000,to_account_id:'acc_alice_sav'})).body;
  const issued=await call('/grants',{grant_id:challenge.grant.grant_id,signature:await sign(challenge.message)});
  ok(issued.body.anchor.status==='CONFIRMED_LOCAL_EVM','signed grant anchored');
  let request=(await call('/requests',{grant_id:challenge.grant.grant_id,amount:300000})).body.result;
  ok(request.status==='AWAITING_APPROVAL','no transfer before user signature');
  const result=(await call('/requests/'+request.id+'/approve',{approve:true,signature:await sign(request.message)})).body;
  ok(result.result.status==='POSTED','existing bank ledger executed');
  ok(result.anchor.status==='CONFIRMED_LOCAL_EVM','execution evidence mined');
  ok((await call('/verify')).body.chain_verified,'onchain receipt verified');
  const before=bank.account('acc_alice_chk')!.available;
  await call('/requests/'+request.id+'/approve',{approve:true,signature:await sign(request.message)});
  ok(bank.account('acc_alice_chk')!.available===before,'HTTP replay no duplicate debit');
  const blocked=(await call('/requests',{grant_id:challenge.grant.grant_id,amount:2000000})).body.result;
  ok(blocked.status==='DENIED','over grant limit rejected');
  ok((await call('/verify')).body.chain_verified,'denial also mined and verified');
  const count=Number(await chain.contract.getFunction('count')());
  const head=await chain.contract.getFunction('head')();
  const other=new Contract(chain.address,chain.contract.interface,await chain.provider.getSigner(1));
  await assert.rejects(()=>other.getFunction('anchor').staticCall(count+1,head,'0x'+'1'.repeat(64)));checks++;
  await assert.rejects(()=>chain.contract.getFunction('anchor').staticCall(count,head,'0x'+'1'.repeat(64)));checks++;
  await assert.rejects(()=>chain.contract.getFunction('anchor').staticCall(count+1,'0x'+'0'.repeat(64),'0x'+'1'.repeat(64)));checks++;
  await assert.rejects(()=>chain.contract.getFunction('anchor').staticCall(count+1,head,'0x'+'0'.repeat(64)));checks++;
  const saved=trust.receipts().at(-1)!;
  trust.db.prepare('UPDATE trust_evidence SET anchor_json=NULL WHERE id=?').run(saved.id);
  await chain.flush(trust);
  ok(Number(await chain.contract.getFunction('count')())===count,'mined receipt recovery without duplicate anchor');
  ok((await chain.verify(trust)).chain_verified,'recovered receipt verified');
  const evilAnchor={...JSON.parse(saved.anchor_json!),transaction_hash:'0x'+'0'.repeat(64)};
  trust.db.prepare('UPDATE trust_evidence SET anchor_json=? WHERE id=?').run(JSON.stringify(evilAnchor),saved.id);
  ok(!(await chain.verify(trust)).valid,'forged transaction receipt rejected');
  trust.db.prepare('UPDATE trust_evidence SET anchor_json=? WHERE id=?').run(saved.anchor_json,saved.id);
  const tampered=canonical({...JSON.parse(saved.payload),event:'FORGED'});
  trust.db.prepare('UPDATE trust_evidence SET payload=?,hash=? WHERE id=?').run(tampered,hash(saved.previous+'\n'+tampered),saved.id);
  ok(trust.verifyLocal().valid,'attacker recomputed local hash chain');
  ok(!(await chain.verify(trust)).valid,'independent chain detects recomputed local tampering');
  trust.db.prepare('UPDATE trust_evidence SET payload=?,hash=? WHERE id=?').run(saved.payload,saved.hash,saved.id);
  trust.db.prepare('DELETE FROM trust_evidence WHERE id=?').run(saved.id);
  ok(!(await chain.verify(trust)).valid,'chain detects deleted tail');
  trust.db.prepare('INSERT INTO trust_evidence VALUES (?,?,?,?,?,?)').run(saved.seq,saved.id,saved.payload,saved.previous,saved.hash,saved.anchor_json);
  await chain.close();
  chain=await LocalChain.open(join(dir,'chain'));runtime.chain=chain;
  ok((await chain.verify(trust)).chain_verified,'persistent chain survives restart');
  console.log(JSON.stringify({status:'PASS',checks,chain_id:chain.chainId,contract:chain.address,anchored_count:count,tests:'HTTP + WebCrypto + existing bank + Solidity + local EVM + restart + tamper detection'},null,2));
} finally {if(runtime)await runtime.chain.close();bank.close();rmSync(dir,{recursive:true,force:true});}
