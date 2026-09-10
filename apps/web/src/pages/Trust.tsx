import './trust.css';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWon } from '../auth';

type Identity = { token:string; key:CryptoKey; human_id:string };
type RequestView = {id:string;body:{human_id:string;from_account_id:string;to_account_id:string;amount:number;expires:number;grant_id:string;domain:string};message:string;status:string;checks:Record<string,string>;result?:{reason_codes?:string[];rule_id?:string;journal_id?:string};error?:string};
type Receipt = {id:string;seq:number;hash:string;payload:{event:string;timestamp:string;request_id?:string};anchor:{transaction_hash:string;block_number:number}|null};
type State = {agents:{id:string;status:string}[];grants:{grant_id:string;max_amount:number;status:string;to_account_id:string;public_key:string}[];requests:RequestView[];receipts:Receipt[];network:{contract:string;chain_id:string};accounts:{id:string;available:number}[]};
const encode=(buffer:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(buffer)));
const canonical=(v:Record<string,unknown>)=>JSON.stringify(v,Object.keys(v).sort());
async function sha256(s:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(n=>n.toString(16).padStart(2,'0')).join('');}

export function TrustPage(){
  const identities=useRef(new Map<string,Identity>());
  const [who,setWho]=useState('syn_alice');
  const [identity,setIdentity]=useState<Identity|null>(null);
  const [state,setState]=useState<State|null>(null);
  const [max,setMax]=useState(1000000);
  const [amount,setAmount]=useState(300000);
  const [to,setTo]=useState('acc_alice_sav');
  const [grantId,setGrantId]=useState('');
  const [current,setCurrent]=useState<RequestView|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [verification,setVerification]=useState<any>(null);
  async function call<T=any>(path:string,body?:unknown,id=identity):Promise<T>{
    const response=await fetch('/api/trust'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(id?{Authorization:'Bearer '+id.token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw new Error(data.error??'요청 실패');return data;
  }
  async function refresh(id=identity){if(id){const s=await call<State>('/state',undefined,id);setState(s);setCurrent(c=>c?s.requests.find(r=>r.id===c.id)??c:null);}}
  async function action(fn:()=>Promise<void>){setBusy(true);setError('');setVerification(null);try{await fn();}catch(e){setError(e instanceof Error?e.message:'처리 실패');}finally{setBusy(false);}}
  async function signature(message:string,id=identity){if(!id)throw new Error('데모 세션을 시작하세요.');return encode(await crypto.subtle.sign('Ed25519',id.key,new TextEncoder().encode(message)));}
  async function login(){await action(async()=>{
    let id=identities.current.get(who);
    if(!id){
      if(!crypto.subtle)throw new Error('localhost 또는 HTTPS와 최신 브라우저가 필요합니다.');
      const pair=await crypto.subtle.generateKey('Ed25519',false,['sign','verify']) as CryptoKeyPair;
      const public_key=encode(await crypto.subtle.exportKey('spki',pair.publicKey));
      const response=await call('/session',{human_id:who,public_key},null);
      id={token:response.token,key:pair.privateKey,human_id:who};identities.current.set(who,id);
    }
    setIdentity(id);setCurrent(null);setGrantId('');await refresh(id);
  });}
  async function issue(){await action(async()=>{
    const c=await call('/grants/challenge',{max_amount:max,to_account_id:to});
    const r=await call('/grants',{grant_id:c.grant.grant_id,signature:await signature(c.message)});
    setGrantId(r.result.grant_id);setCurrent(null);await refresh();
  });}
  async function propose(){await action(async()=>{const r=await call('/requests',{grant_id:grantId,amount});setCurrent(r.result);await refresh();});}
  async function approve(yes:boolean){if(!current)return;await action(async()=>{
    const message=yes?current.message:canonical({domain:current.body.domain,request_id:current.id,commitment:await sha256(current.message),decision:'DENY'});
    const r=await call('/requests/'+current.id+'/approve',{approve:yes,signature:await signature(message)});
    setCurrent(r.result);if(r.result.error)setError(r.result.error);await refresh();
  });}
  async function operator(r:RequestView,approve:boolean){await action(async()=>{
    const c=await call('/requests/'+r.id+'/operator-challenge',{approve});
    const result=await call('/operator-decision',{challenge_id:c.challenge.challenge_id,signature:await signature(c.message)});
    setCurrent(result.result);if(result.result.error)setError(result.result.error);await refresh();
  });}
  async function revoke(kind:string,id:string){await action(async()=>{await call('/revoke',{kind,id});await refresh();});}
  function exportEvidence(){const blob=new Blob([JSON.stringify({network:state?.network,receipts:state?.receipts,verification},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='sapiensq-trust-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  useEffect(()=>{setIdentity(null);setState(null);setCurrent(null);setGrantId('');},[who]);
  const isOperator=identity?.human_id==='syn_operator';
  const status=(key:string)=>current?.checks[key]??'WAIT';
  const stages=[['사람 세션','Sandbox SSO',identity?'PASS':'WAIT'],['에이전트 서명','Ed25519',status('agent')],['위임장 검증','Signed grant',status('delegation')],['위임 한도','Transaction + budget',status('limit')],['거래 승인','Signed approval',status('approval')],['은행 실행','Existing ledger',status('execution')],['체인 증적 검증','Local EVM',verification?.chain_verified?'PASS':verification&&!verification.valid?'FAIL':'WAIT']];
  return <div className="trust-page">
    <div className="trust-intro"><div><span className="trust-eyebrow">SAPIENSQ / TRUST LAYER</span><h2>승인한 범위 안에서만 실행합니다.</h2><p>기존 규칙 기반 에이전트와 모의 원장에 서명·위임·체인 증적을 연결했습니다.</p></div><span className="trust-badge">개발용 블록체인</span></div>
    <section className="trust-login"><label>합성 신원 <select value={who} disabled={busy} onChange={e=>setWho(e.target.value)}><option value="syn_alice">앨리스 · 거래 요청자</option><option value="syn_operator">운영자 · 추가 승인자</option></select></label><button disabled={busy} onClick={login}>{identity?'데모 세션 새로고침':'데모 세션 시작'}</button><span>{identity?'세션 연결됨 · '+identity.human_id:'세션을 시작하면 브라우저에서 서명키를 생성합니다.'}</span></section>
    <p className="trust-note">신원 선택은 실명인증이 아닌 샌드박스 SSO입니다. 서명은 실제 검증하며 개인키는 이 탭 메모리에만 보관합니다. 새로고침하면 다시 위임해야 합니다.</p>
    <ol className="trust-stages" aria-label="실행 검증 단계">{stages.map(([label,sub,value],i)=><li key={label} className={'stage-'+value}><span className="trust-step">{i+1}</span><div><strong>{label}</strong><small>{sub}</small></div><b>{value==='PASS'?'통과':value==='FAIL'?'차단':value==='PENDING'?'추가 승인':'대기'}</b></li>)}</ol>
    {identity&&!isOperator&&<div className="trust-grid"><section className="trust-card"><h3>1. 에이전트에게 권한 위임</h3><p>출금: 앨리스 입출금통장<br/>에이전트: agent_transfer_v1</p><label>허용할 수취 계좌<select value={to} disabled={busy} onChange={e=>{setTo(e.target.value);setGrantId('');}}><option value="acc_alice_sav">앨리스 적금 · 일반 이체</option><option value="acc_bob_chk">밥 입출금 · 운영자 추가 승인</option></select></label><label>1회 위임 한도 (원)<input type="number" min="1" max="5000000" value={max} onChange={e=>{setMax(Number(e.target.value));setGrantId('');}} /></label><p className="trust-note">위임 총액·은행 일일 한도 각 500만원. 위임은 30분 이내에 만료됩니다.</p><button disabled={busy||!Number.isSafeInteger(max)||max<1||max>5000000} onClick={issue}>이 범위에 서명하고 위임</button>{grantId&&<p className="trust-success">서명된 위임장 발급 완료</p>}</section><section className="trust-card"><h3>2. 거래를 검증하고 승인</h3><label>요청 금액 (원)<input type="number" min="1" value={amount} onChange={e=>setAmount(Number(e.target.value))}/></label><button disabled={busy||!grantId||!Number.isSafeInteger(amount)||amount<1} onClick={propose}>에이전트 거래 요청 검증</button>{current&&<div className="trust-review"><h4>{formatWon(current.body.amount)}</h4><p>{current.body.from_account_id} → {current.body.to_account_id}</p><p>상태: <strong>{current.status}</strong></p><p>{current.result?.reason_codes?.join(' / ')??current.result?.rule_id}</p>{current.status==='AWAITING_APPROVAL'&&<><p>위 계좌와 금액을 확인했습니다. 아래 승인은 이 거래 내용에만 유효합니다.</p><div className="actions"><button disabled={busy} onClick={()=>approve(true)}>위 거래에 서명하고 실행</button><button className="secondary" disabled={busy} onClick={()=>approve(false)}>거절</button></div></>}{current.status==='PENDING'&&<p>원장에 승인 대기로 접수되었습니다. 운영자 데모 세션에서 추가 승인하세요.</p>}</div>}</section></div>}
    {identity&&isOperator&&<section className="trust-card"><h3>운영자 추가 승인</h3><p>요청자 승인과 별도로, 운영자의 거래별 서명을 검증합니다.</p>{state?.requests.filter(r=>r.status==='PENDING').map(r=><div className="trust-review" key={r.id}><strong>{formatWon(r.body.amount)}</strong><p>{r.body.from_account_id} → {r.body.to_account_id}</p><div className="actions"><button disabled={busy} onClick={()=>operator(r,true)}>서명하고 추가 승인</button><button disabled={busy} className="secondary" onClick={()=>operator(r,false)}>거절</button></div></div>)}{!state?.requests.some(r=>r.status==='PENDING')&&<p>승인 대기 거래가 없습니다.</p>}</section>}
    {error&&<p role="alert" className="trust-error">{error}</p>}
    {identity&&<><section className="trust-card"><div className="trust-heading"><h3>3. 증적과 블록체인 대조</h3><div className="actions"><button disabled={busy} onClick={()=>action(async()=>{setVerification(await call('/verify'));await refresh();})}>기록 검증</button>{isOperator&&<button disabled={busy} className="secondary" onClick={()=>action(async()=>{await call('/anchor',{});await refresh();})}>미등록 기록 재시도</button>}<button disabled={busy||!state?.receipts.length} className="secondary" onClick={exportEvidence}>증적 JSON 저장</button></div></div><p className="trust-note">개발용 EVM에서 실제 채굴된 기록입니다. 로컬 체인 운영자가 전체 환경을 변경하는 공격에 대한 외부 보증은 제공하지 않습니다.</p>{verification&&<p role="status" className={verification.chain_verified?'trust-success':'trust-error'}>{verification.chain_verified?'검증 통과 · 로컬 원장과 체인 증적 일치':'검증 결과: '+verification.reason}</p>}<div className="trust-table"><table><thead><tr><th>순서</th><th>이벤트</th><th>체인 상태</th><th>트랜잭션</th></tr></thead><tbody>{[...(state?.receipts??[])].reverse().slice(0,12).map(r=><tr key={r.id}><td>{r.seq}</td><td>{r.payload.event}</td><td>{r.anchor?'확인 · 블록 '+r.anchor.block_number:'등록 대기'}</td><td><code title={r.anchor?.transaction_hash}>{r.anchor?.transaction_hash.slice(0,18)??'—'}</code></td></tr>)}</tbody></table></div><details><summary>개발용 체인 정보</summary><p className="trust-wrap">Chain ID: {state?.network.chain_id}<br/>Contract: {state?.network.contract}</p></details></section><details className="trust-card"><summary>위임·에이전트 철회 및 거래 기록</summary><p>철회 후에는 아직 실행하지 않은 거래의 승인이 차단됩니다. 완료된 거래를 되돌리지는 않습니다.</p>{state?.grants.filter(g=>g.status==='ACTIVE').map(g=><p className="trust-wrap" key={g.grant_id}>위임 {g.grant_id.slice(0,8)} · {formatWon(g.max_amount)} <button className="secondary" disabled={busy} onClick={()=>revoke('grant',g.grant_id)}>위임 철회</button></p>)}{isOperator&&state?.agents.map(a=><p key={a.id}>{a.id} · {a.status} <button disabled={busy||a.status==='REVOKED'} className="secondary" onClick={()=>revoke('agent',a.id)}>에이전트 철회</button></p>)}{state?.requests.map(r=><p key={r.id}><button className="secondary" disabled={busy} onClick={()=>setCurrent(r)}>{r.id.slice(0,8)} · {formatWon(r.body.amount)} · {r.status}</button></p>)}</details><p><Link to="/ledger">기존 원장 보기</Link> · <Link to="/money">기존 자금 화면 보기</Link></p></>}
  </div>;
}
