import { createHash, createPublicKey, randomBytes, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { Bank } from './bank.js';
import { withTx } from './db.js';

export function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).filter(k => obj[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const signText = (key: KeyObject, text: string) => sign(null, Buffer.from(text), key).toString('base64');
export function verifyText(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki'});
    return key.asymmetricKeyType === 'ed25519' && verify(null, Buffer.from(text), key, Buffer.from(signature, 'base64'));
  } catch { return false; }
}
export type Human = { human_id: string; customer_id: string; role: 'customer'|'operator'; public_key: string; expires: number };
export type Grant = { domain: string; grant_id: string; human_id: string; public_key: string; agent_id: string; action: string; from_account_id: string; to_account_id: string; max_amount: number; total_budget: number; currency: string; expires: number; nonce: string };
export type Request = { domain: string; request_id: string; human_id: string; public_key: string; agent_id: string; grant_id: string; action: string; from_account_id: string; to_account_id: string; amount: number; currency: string; expires: number; nonce: string };
export type Receipt = { seq: number; id: string; payload: string; previous: string; hash: string; anchor_json: string|null };
export type RequestView = { id: string; body: Request; message: string; agent_signature: string; human_signature: string|null; status: string; result: any; checks: Record<string,string> };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS trust_sessions(token_hash TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_agents(id TEXT PRIMARY KEY, public_key TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_challenges(id TEXT PRIMARY KEY, body TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS trust_grants(id TEXT PRIMARY KEY, body TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trust_requests(id TEXT PRIMARY KEY, body TEXT NOT NULL, agent_signature TEXT NOT NULL, human_signature TEXT, status TEXT NOT NULL, result TEXT);
CREATE TABLE IF NOT EXISTS trust_evidence(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL, anchor_json TEXT);
`;

/** Sandbox SSO enrollment, real Ed25519 signatures, existing bank ledger only. */
export class Trust {
  readonly db;
  readonly domain: string;
  constructor(readonly bank: Bank, readonly agentKey: KeyObject, domain='sapiensq-local-trust-v1') {
    this.db = bank.db;
    this.domain = domain;
    this.db.exec(SCHEMA);
    const pub = createPublicKey(agentKey).export({format:'der',type:'spki'}).toString('base64');
    const old = this.db.prepare('SELECT * FROM trust_agents WHERE id=?').get('agent_transfer_v1') as any;
    if (old && old.public_key !== pub) throw new Error('Agent key mismatch: restore original key; do not silently rotate');
    this.db.prepare("INSERT OR IGNORE INTO trust_agents VALUES (?,?, 'ACTIVE')").run('agent_transfer_v1', pub);
  }
  login(human_id: string, public_key: string) {
    if (!['syn_alice','syn_bob','syn_operator'].includes(human_id)) throw new Error('SYNTHETIC_ID_REQUIRED');
    const key = createPublicKey({key:Buffer.from(public_key,'base64'),format:'der',type:'spki'});
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('ED25519_REQUIRED');
    const body: Human = {human_id, customer_id:human_id === 'syn_operator' ? '' : human_id, role:human_id === 'syn_operator'?'operator':'customer', public_key, expires:Date.now()+3600000};
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO trust_sessions VALUES (?,?)').run(hash(token),canonical(body));
    return {token, human:body, identity_mode:'SANDBOX_SSO_STUB'};
  }
  authenticate(token: string): Human {
    const row = this.db.prepare('SELECT body FROM trust_sessions WHERE token_hash=?').get(hash(token)) as any;
    if (!row) throw new Error('SESSION_REQUIRED');
    const human: Human = JSON.parse(row.body);
    if (human.expires <= Date.now()) throw new Error('SESSION_EXPIRED');
    return human;
  }
  logout(token: string) { this.db.prepare('DELETE FROM trust_sessions WHERE token_hash=?').run(hash(token)); }
  agents() { return this.db.prepare('SELECT * FROM trust_agents').all(); }
  grant(human: Human, input: {max_amount: number; to_account_id:string}) {
    if (human.role !== 'customer') throw new Error('CUSTOMER_REQUIRED');
    if (!Number.isSafeInteger(input.max_amount) || input.max_amount < 1 || input.max_amount > 5000000) throw new Error('INVALID_GRANT_LIMIT');
    const from = human.customer_id === 'syn_alice' ? 'acc_alice_chk' : 'acc_bob_chk';
    const to = this.bank.account(input.to_account_id);
    if (!to || to.product === 'HOUSE' || to.id === from) throw new Error('INVALID_DESTINATION');
    const g: Grant = {domain:this.domain,grant_id:randomUUID(),human_id:human.human_id,public_key:human.public_key,agent_id:'agent_transfer_v1', action:'TRANSFER',from_account_id:from,to_account_id:to.id,max_amount:input.max_amount,total_budget:5000000,currency:'KRW',expires:Math.min(human.expires,Date.now()+1800000),nonce:randomBytes(32).toString('hex')};
    const message = canonical(g);
    this.db.prepare('INSERT INTO trust_challenges(id,body) VALUES (?,?)').run(g.grant_id,message);
    return {grant:g,message};
  }
  issueGrant(human: Human, id:string, signature:string) {
    const row = this.db.prepare('SELECT * FROM trust_challenges WHERE id=?').get(id) as any;
    if (!row || row.used) throw new Error('CHALLENGE_INVALID');
    const grant: Grant = JSON.parse(row.body);
    if (grant.domain !== this.domain || grant.human_id !== human.human_id || grant.public_key !== human.public_key || grant.expires <= Date.now() || !verifyText(human.public_key,row.body,signature)) throw new Error('GRANT_SIGNATURE_INVALID');
    return withTx(this.db,()=>{
      this.db.prepare('UPDATE trust_challenges SET used=1 WHERE id=?').run(id);
      this.db.prepare("INSERT INTO trust_grants VALUES (?,?,?,'ACTIVE')").run(id,row.body,signature);
      this.evidence({event:'GRANT_ISSUED',human_id:human.human_id,grant,signature});
      return {grant_id:id,status:'ACTIVE'};
    });
  }
  getGrant(id:string) { return this.db.prepare('SELECT * FROM trust_grants WHERE id=?').get(id) as any; }
  view(id:string): RequestView {
    const row = this.db.prepare('SELECT * FROM trust_requests WHERE id=?').get(id) as any;
    if (!row) throw new Error('REQUEST_NOT_FOUND');
    const body: Request = JSON.parse(row.body);
    const result = row.result ? JSON.parse(row.result) : null;
    return {id,body,message:row.body,agent_signature:row.agent_signature,human_signature:row.human_signature,status:row.status,result,checks:result?.checks ?? {}};
  }
  check(human: Human, request: Request, signature: string) {
    const checks: Record<string,string> = {};
    const errors: string[] = [];
    const check = (name:string, ok:boolean, error:string) => { checks[name]=ok?'PASS':'FAIL'; if (!ok) errors.push(error); };
    check('human',human.role==='customer' && request.human_id===human.human_id && request.public_key===human.public_key && human.expires>Date.now(),'HUMAN_MISMATCH');
    const agent = this.db.prepare('SELECT * FROM trust_agents WHERE id=?').get(request.agent_id) as any;
    check('agent',!!agent && agent.status==='ACTIVE' && verifyText(agent.public_key,canonical(request),signature),'AGENT_INVALID_OR_REVOKED');
    const row = this.getGrant(request.grant_id);
    const g: Grant|null = row ? JSON.parse(row.body) : null;
    check('delegation',!!g && row.status==='ACTIVE' && verifyText(g.public_key,row.body,row.signature) && g.domain===this.domain && g.human_id===human.human_id && g.public_key===human.public_key && g.agent_id===request.agent_id && g.action===request.action && g.from_account_id===request.from_account_id && g.to_account_id===request.to_account_id && g.currency===request.currency && g.expires>Date.now(),'GRANT_INVALID_OR_REVOKED');
    const spent = this.db.prepare("SELECT COALESCE(SUM(json_extract(body,'$.amount')),0) AS total FROM trust_requests WHERE json_extract(body,'$.grant_id')=? AND id<>? AND status IN ('POSTED','PENDING')").get(request.grant_id,request.request_id) as any;
    check('limit',!!g && Number.isSafeInteger(request.amount) && request.amount>0 && request.amount<=g.max_amount && request.amount+Number(spent.total)<=g.total_budget,'DELEGATED_LIMIT_EXCEEDED');
    check('validity',request.domain===this.domain && request.action==='TRANSFER' && request.currency==='KRW' && request.expires>Date.now(),'REQUEST_EXPIRED_OR_INVALID');
    return {authorized:errors.length===0, reason_codes:errors, checks};
  }
  propose(human: Human, grant_id:string, amount:number) {
    const row = this.getGrant(grant_id);
    if (!row) throw new Error('GRANT_NOT_FOUND');
    const grant: Grant = JSON.parse(row.body);
    if (grant.human_id!==human.human_id || grant.public_key!==human.public_key) throw new Error('GRANT_OWNER_MISMATCH');
    if (!Number.isSafeInteger(amount) || amount<1) throw new Error('INVALID_AMOUNT');
    const request: Request = {domain:this.domain,request_id:randomUUID(),human_id:human.human_id,public_key:human.public_key,agent_id:grant.agent_id,grant_id,action:'TRANSFER',from_account_id:grant.from_account_id,to_account_id:grant.to_account_id,amount,currency:'KRW',expires:Math.min(grant.expires,Date.now()+300000),nonce:randomBytes(32).toString('hex')};
    const message=canonical(request), signature=signText(this.agentKey,message);
    const checked=this.check(human,request,signature);
    return withTx(this.db,()=>{
      this.db.prepare('INSERT INTO trust_requests VALUES (?,?,?,NULL,?,?)').run(request.request_id,message,signature,checked.authorized?'AWAITING_APPROVAL':'DENIED',canonical(checked));
      this.evidence({event:'AUTHORIZATION',human_id:human.human_id,request,agent_signature:signature,grant:JSON.parse(row.body),grant_signature:row.signature,...checked});
      return this.view(request.request_id);
    });
  }
  execute(human: Human, id:string, signature:string, approve:boolean) {
    return withTx(this.db,()=>{
      const view=this.view(id), p=view.body;
      if (p.human_id!==human.human_id || p.public_key!==human.public_key) throw new Error('REQUEST_OWNER_MISMATCH');
      const signedMessage=approve?view.message:canonical({domain:this.domain,request_id:id,commitment:hash(view.message),decision:'DENY'});
      if (!verifyText(human.public_key,signedMessage,signature)) {
        this.evidence({event:'INVALID_APPROVAL',human_id:human.human_id,request_id:id,reason_codes:['SIGNATURE_INVALID']});
        return {...view, error:'SIGNATURE_INVALID'};
      }
      if (view.status!=='AWAITING_APPROVAL') return {...view,replay:true};
      const checks=this.check(human,p,view.agent_signature);
      checks.checks.approval=approve?'PASS':'FAIL';
      if (!approve || !checks.authorized) {
        const result={...checks,authorized:false,reason_codes:approve?checks.reason_codes:['USER_DENIED']};
        this.db.prepare("UPDATE trust_requests SET status='DENIED',human_signature=?,result=? WHERE id=?").run(signature,canonical(result),id);
        this.evidence({event:'DENIED',human_id:human.human_id,request:p,approval_message:signedMessage,human_signature:signature,...result});
        return this.view(id);
      }
      // Existing bank orchestration + policy + ledger; a fresh session avoids stale policy decisions.
      const session=this.bank.startSession(human.customer_id);
      this.bank.tool(session.id,'handoff',{to:'transfer'});
      const result=this.bank.tool(session.id,'transfer',{from_account_id:p.from_account_id,to_account_id:p.to_account_id,amount:p.amount,idempotency_key:'trust:'+id});
      const status=result.journal_status ?? 'DENIED';
      const combined={...result,checks:{...checks.checks,execution:status==='POSTED'?'PASS':status==='PENDING'?'PENDING':'FAIL'}};
      this.db.prepare('UPDATE trust_requests SET status=?,human_signature=?,result=? WHERE id=?').run(status,signature,canonical(combined),id);
      this.evidence({event:'EXECUTION',human_id:human.human_id,request:p,human_signature:signature,agent_signature:view.agent_signature,result:combined,journal:result.journal_id?this.bank.journal(result.journal_id):null,entries:result.journal_id?this.bank.journalEntries(result.journal_id):[]});
      return this.view(id);
    });
  }
  operatorChallenge(human:Human,id:string,approve:boolean) {
    const view=this.view(id);
    if (human.role!=='operator' || view.body.human_id===human.human_id || view.status!=='PENDING') throw new Error('INDEPENDENT_OPERATOR_REQUIRED');
    const body={domain:this.domain,challenge_id:randomUUID(),request_id:id,commitment:hash(view.message),human_id:human.human_id,public_key:human.public_key,decision:approve?'APPROVE_PENDING':'DENY_PENDING',expires:Date.now()+300000};
    const message=canonical(body);
    this.db.prepare('INSERT INTO trust_challenges(id,body) VALUES (?,?)').run(body.challenge_id,message);
    return {challenge:body,message};
  }
  operatorDecision(human:Human,challengeId:string,signature:string) {
    return withTx(this.db,()=>{
      const row=this.db.prepare('SELECT * FROM trust_challenges WHERE id=?').get(challengeId) as any;
      if (!row) throw new Error('CHALLENGE_INVALID');
      const c=JSON.parse(row.body), view=this.view(c.request_id), p=view.body;
      if (row.used || c.domain!==this.domain || c.expires<=Date.now() || c.public_key!==human.public_key || c.human_id!==human.human_id || human.role!=='operator' || c.commitment!==hash(view.message) || view.status!=='PENDING' || !verifyText(human.public_key,row.body,signature)) throw new Error('OPERATOR_APPROVAL_INVALID');
      if (!['APPROVE_PENDING','DENY_PENDING'].includes(c.decision)) throw new Error('DECISION_INVALID');
      const approve=c.decision==='APPROVE_PENDING';
      const customer: Human={human_id:p.human_id,customer_id:p.human_id,role:'customer',public_key:p.public_key,expires:p.expires};
      const checks=this.check(customer,p,view.agent_signature);
      const journal=this.bank.journal(view.result.journal_id);
      if (!journal || journal.amount!==p.amount || journal.from_account_id!==p.from_account_id || journal.to_account_id!==p.to_account_id) throw new Error('JOURNAL_CHANGED');
      const frozen=[p.from_account_id,p.to_account_id].some(id=>this.bank.account(id)?.status!=='OPEN');
      if (approve && (!checks.authorized || frozen)) {
        this.evidence({event:'OPERATOR_BLOCKED',human_id:human.human_id,request_id:p.request_id,reason_codes:frozen?['ACCOUNT_FROZEN']:checks.reason_codes});
        return {...view,error:frozen?'ACCOUNT_FROZEN':checks.reason_codes.join(',')};
      }
      this.db.prepare('UPDATE trust_challenges SET used=1 WHERE id=?').run(challengeId);
      const result=approve?this.bank.approve(journal.id,{actor:'operator'}):this.bank.deny(journal.id,{actor:'operator'});
      const status=result.journal_status ?? view.status;
      const combined={...result,checks:{...view.checks,operator:approve?'PASS':'FAIL',execution:status==='POSTED'?'PASS':'FAIL'}};
      this.db.prepare('UPDATE trust_requests SET status=?,result=? WHERE id=?').run(status,canonical(combined),p.request_id);
      this.evidence({event:'OPERATOR_DECISION',human_id:human.human_id,request_id:p.request_id,approval: c,operator_signature:signature,result:combined,journal:this.bank.journal(journal.id),entries:this.bank.journalEntries(journal.id)});
      return this.view(p.request_id);
    });
  }
  revoke(human:Human,kind:'agent'|'grant',id:string) {
    if (kind==='agent' && human.role!=='operator') throw new Error('OPERATOR_REQUIRED');
    const row=kind==='grant'?this.getGrant(id):this.db.prepare('SELECT * FROM trust_agents WHERE id=?').get(id) as any;
    if (!row) throw new Error('NOT_FOUND');
    if (kind==='grant' && human.role!=='operator' && JSON.parse(row.body).human_id!==human.human_id) throw new Error('GRANT_OWNER_MISMATCH');
    return withTx(this.db,()=>{
      this.db.prepare(`UPDATE ${kind==='grant'?'trust_grants':'trust_agents'} SET status='REVOKED' WHERE id=?`).run(id);
      return this.evidence({event:'REVOKED',human_id:human.human_id,kind,target:id});
    });
  }
  evidence(data:Record<string,unknown>) {
    const last=this.db.prepare('SELECT hash FROM trust_evidence ORDER BY seq DESC LIMIT 1').get() as any;
    const id=randomUUID(), previous=last?.hash ?? '0'.repeat(64);
    const payload=canonical({version:1,domain:this.domain,id,timestamp:new Date().toISOString(),nonce:randomBytes(32).toString('hex'),...data});
    const digest=hash(previous+'\n'+payload);
    this.db.prepare('INSERT INTO trust_evidence(id,payload,previous,hash) VALUES (?,?,?,?)').run(id,payload,previous,digest);
    return this.db.prepare('SELECT * FROM trust_evidence WHERE id=?').get(id) as Receipt;
  }
  receipts(): Receipt[] { return this.db.prepare('SELECT * FROM trust_evidence ORDER BY seq').all() as Receipt[]; }
  verifyLocal() {
    let previous='0'.repeat(64),seq=0;
    const journals=new Map<string, {journal:unknown;entries:unknown}>();
    for (const r of this.receipts()) {
      if (r.seq!==++seq || r.previous!==previous || hash(r.previous+'\n'+r.payload)!==r.hash) return {valid:false,reason:'HASH_CHAIN_MISMATCH',seq:r.seq};
      try {
        const p=JSON.parse(r.payload);
        if (p.domain!==this.domain || p.id!==r.id) return {valid:false,reason:'DOMAIN_MISMATCH',seq:r.seq};
        if (p.journal) journals.set(p.journal.id,{journal:p.journal,entries:p.entries});
      } catch { return {valid:false,reason:'PAYLOAD_INVALID',seq:r.seq}; }
      previous=r.hash;
    }
    for (const [id,snapshot] of journals) {
      if (canonical(this.bank.journal(id))!==canonical(snapshot.journal) || canonical(this.bank.journalEntries(id))!==canonical(snapshot.entries)) return {valid:false,reason:'BANK_JOURNAL_CHANGED',seq};
    }
    return {valid:true,head:previous,count:seq,reason:'LOCAL_HASH_CHAIN_ONLY'};
  }
}
