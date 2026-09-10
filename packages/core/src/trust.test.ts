import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { Bank } from './bank.js';
import { Trust, canonical, hash, signText, type Human } from './trust.js';

describe('Trust + existing bank ledger',()=>{
  let bank:Bank,trust:Trust,human:Human,operator:Human;
  const humanKey=generateKeyPairSync('ed25519').privateKey;
  const opKey=generateKeyPairSync('ed25519').privateKey;
  const agentKey=generateKeyPairSync('ed25519').privateKey;
  const pub=(k:typeof humanKey)=>createPublicKey(k).export({format:'der',type:'spki'}).toString('base64');
  beforeEach(()=>{bank=new Bank();bank.seed();trust=new Trust(bank,agentKey);human=trust.login('syn_alice',pub(humanKey)).human;operator=trust.login('syn_operator',pub(opKey)).human;});
  afterEach(()=>bank.close());
  const grant=(amount=1000000,to='acc_alice_sav')=>{const c=trust.grant(human,{max_amount:amount,to_account_id:to});trust.issueGrant(human,c.grant.grant_id,signText(humanKey,c.message));return c.grant.grant_id;};
  const execute=(id:string)=>trust.execute(human,id,signText(humanKey,trust.view(id).message),true);
  it('requires explicit signed approval, executes existing journal and prevents duplicate debit',()=>{
    const before=bank.account('acc_alice_chk')!.available;
    const p=trust.propose(human,grant(),300000);
    expect(bank.account('acc_alice_chk')!.available).toBe(before);
    const r=execute(p.id);expect(r.status).toBe('POSTED');
    expect(execute(p.id).status).toBe('POSTED');
    expect(bank.account('acc_alice_chk')!.available).toBe(before-300000);
    expect(bank.journals().filter(j=>j.idempotency_key==='trust:'+p.id)).toHaveLength(1);
    expect(trust.verifyLocal().valid).toBe(true);
  });
  it('denies delegated limit and writes evidence without money movement',()=>{
    const p=trust.propose(human,grant(100000),300000);
    expect(p.status).toBe('DENIED');expect(p.checks.limit).toBe('FAIL');
    expect(bank.journals()).toHaveLength(1);expect(trust.receipts().length).toBe(2);
  });
  it('rejects wrong approval key and accepts a subsequent valid approval',()=>{
    const p=trust.propose(human,grant(),1000);
    expect(trust.execute(human,p.id,signText(opKey,p.message),true)).toHaveProperty('error','SIGNATURE_INVALID');
    expect(bank.journals()).toHaveLength(1);expect(execute(p.id).status).toBe('POSTED');
  });
  it('rejects modified grant and replayed issuance',()=>{
    const c=trust.grant(human,{max_amount:100000,to_account_id:'acc_alice_sav'});
    const sig=signText(humanKey,c.message);
    expect(()=>trust.issueGrant(human,c.grant.grant_id,signText(opKey,c.message))).toThrow();
    trust.issueGrant(human,c.grant.grant_id,sig);
    expect(()=>trust.issueGrant(human,c.grant.grant_id,sig)).toThrow();
    trust.db.prepare('UPDATE trust_grants SET body=?').run(canonical({...c.grant,max_amount:5000000}));
    expect(trust.propose(human,c.grant.grant_id,300000).checks.delegation).toBe('FAIL');
  });
  it('rechecks revocation between planning and execution',()=>{
    const id=grant(),p=trust.propose(human,id,1000);trust.revoke(human,'grant',id);
    expect(execute(p.id).status).toBe('DENIED');expect(bank.journals()).toHaveLength(1);
  });
  it('rejects revoked and unknown agent signatures',()=>{
    const id=grant(),p=trust.propose(human,id,1000);trust.revoke(operator,'agent','agent_transfer_v1');
    expect(execute(p.id).status).toBe('DENIED');
    expect(trust.check(human,{...p.body,agent_id:'unknown'},p.agent_signature).checks.agent).toBe('FAIL');
  });
  it('checks signed request expiry at execution',()=>{
    const p=trust.propose(human,grant(),1000);
    const expired={...p.body,expires:Date.now()-100};
    trust.db.prepare('UPDATE trust_requests SET body=?,agent_signature=? WHERE id=?').run(canonical(expired),signText(agentKey,canonical(expired)),p.id);
    expect(execute(p.id).status).toBe('DENIED');
  });
  it('prevents changed amount approval and wrong human',()=>{
    const p=trust.propose(human,grant(),1000);
    expect(()=>trust.execute(operator,p.id,signText(opKey,p.message),true)).toThrow();
    trust.db.prepare('UPDATE trust_requests SET body=? WHERE id=?').run(canonical({...p.body,amount:9999}),p.id);
    expect(trust.execute(human,p.id,signText(humanKey,p.message),true)).toHaveProperty('error','SIGNATURE_INVALID');
    expect(bank.journals()).toHaveLength(1);
  });
  it('records a signed refusal without creating journal',()=>{
    const p=trust.propose(human,grant(),1000);
    const message=canonical({domain:trust.domain,request_id:p.id,commitment:hash(p.message),decision:'DENY'});
    expect(trust.execute(human,p.id,signText(humanKey,message),false).status).toBe('DENIED');
    expect(bank.journals()).toHaveLength(1);
  });
  it('preserves independent operator approval and existing decision_ref',()=>{
    const p=trust.propose(human,grant(1000000,'acc_bob_chk'),300000);
    const r=execute(p.id);expect(r.status).toBe('PENDING');
    expect(()=>trust.operatorChallenge(human,p.id,true)).toThrow();
    const c=trust.operatorChallenge(operator,p.id,true);
    const result=trust.operatorDecision(operator,c.challenge.challenge_id,signText(opKey,c.message));
    expect(result.status).toBe('POSTED');
    expect(result.result.decision_ref).toBe(r.result.decision_ref);
    expect(()=>trust.operatorDecision(operator,c.challenge.challenge_id,signText(opKey,c.message))).toThrow();
    expect(trust.verifyLocal().valid).toBe(true);
  });
  it('rechecks frozen account on independent approval, permits cancellation',()=>{
    const p=trust.propose(human,grant(1000000,'acc_bob_chk'),300000);execute(p.id);
    bank.setStatus('acc_alice_chk','FROZEN');
    const c=trust.operatorChallenge(operator,p.id,true);
    expect(trust.operatorDecision(operator,c.challenge.challenge_id,signText(opKey,c.message))).toHaveProperty('error','ACCOUNT_FROZEN');
    const deny=trust.operatorChallenge(operator,p.id,false);
    expect(trust.operatorDecision(operator,deny.challenge.challenge_id,signText(opKey,deny.message)).status).toBe('DENIED');
  });
  it('preserves bank daily cap even when delegation permits transaction',()=>{
    const id=grant(5000000),p=trust.propose(human,id,3000000);expect(execute(p.id).status).toBe('PENDING');
    const q=trust.propose(human,grant(5000000),3000000);expect(execute(q.id).result.rule_id).toBe('DAILY_CAP');
  });
  it('enforces cumulative delegation budget',()=>{
    const id=grant(5000000);execute(trust.propose(human,id,3000000).id);
    expect(trust.propose(human,id,3000000).checks.limit).toBe('FAIL');
  });
  it('preserves NSF and frozen policy without weakening core',()=>{
    const bobKey=generateKeyPairSync('ed25519').privateKey;
    const bob=trust.login('syn_bob',pub(bobKey)).human;
    const c=trust.grant(bob,{max_amount:1000000,to_account_id:'acc_bob_sav'});trust.issueGrant(bob,c.grant.grant_id,signText(bobKey,c.message));
    const p=trust.propose(bob,c.grant.grant_id,900000);
    expect(trust.execute(bob,p.id,signText(bobKey,p.message),true).result.rule_id).toBe('NSF');
    bank.setStatus('acc_alice_chk','FROZEN');expect(execute(trust.propose(human,grant(),1000).id).result.rule_id).toBe('ACCOUNT_FROZEN');
  });
  it('rolls back bank movement if writing its evidence fails',()=>{
    const p=trust.propose(human,grant(),1000),before=bank.account('acc_alice_chk')!.available;
    trust.db.exec("CREATE TRIGGER evidence_fail BEFORE INSERT ON trust_evidence BEGIN SELECT RAISE(ABORT,'disk failure'); END");
    expect(()=>execute(p.id)).toThrow();expect(bank.account('acc_alice_chk')!.available).toBe(before);
    expect(trust.view(p.id).status).toBe('AWAITING_APPROVAL');
  });
  it('detects evidence tampering and bank journal mutation',()=>{
    const r=execute(trust.propose(human,grant(),1000).id);
    bank.db.prepare('UPDATE journals SET amount=2 WHERE id=?').run(r.result.journal_id);
    expect(trust.verifyLocal().valid).toBe(false);
    bank.db.prepare("UPDATE trust_evidence SET payload='{}' WHERE seq=1").run();
    expect(trust.verifyLocal().reason).toBe('HASH_CHAIN_MISMATCH');
  });
  it('expires and revokes bearer sessions',()=>{
    const session=trust.login('syn_alice',pub(humanKey));expect(trust.authenticate(session.token).human_id).toBe('syn_alice');
    trust.logout(session.token);expect(()=>trust.authenticate(session.token)).toThrow();
  });
});
