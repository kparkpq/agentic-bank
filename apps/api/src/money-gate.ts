import type { MiddlewareHandler } from 'hono';
import type { Bank } from '@sapiensq/core';
/** Existing unprotected HTTP settlement endpoints are closed, not a second execution path. */
export function moneyGate(bank:Bank):MiddlewareHandler {
  return async(c,next)=>{
    if(c.req.method==='POST') {
      const path=c.req.path;
      let blocked=/^\/api\/proposals\/[^/]+\/execute$/.test(path)||path==='/api/operator/approve'||path==='/api/operator/deny';
      if(path==='/api/tools') {
        const body=await c.req.json().catch(()=>({}));
        blocked=body.action==='transfer';
        const auth=c.get('auth');
        if(auth?.role==='customer'&&!bank.sessions().some(s=>s.id===body.session_id&&s.customer_id===auth.customer_id))return c.json({error:'SESSION_OWNER_MISMATCH'},403);
      }
      if(blocked)return c.json({error:'TRUST_SIGNATURE_REQUIRED: 신뢰 검증 화면에서 서명 후 실행하세요.',route:'/trust-demo'},428);
    }
    await next();
  };
}
