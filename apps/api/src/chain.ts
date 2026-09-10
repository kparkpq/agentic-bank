import ganache from 'ganache';
import solc from 'solc';
import { BrowserProvider, Contract, ContractFactory } from 'ethers';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, type Trust, type Receipt } from '@sapiensq/core';

export function compileAnchor() {
  const source = readFileSync(fileURLToPath(new URL('../contracts/TrustAnchor.sol',import.meta.url)),'utf8');
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'TrustAnchor.sol':{content:source}},settings:{evmVersion:'shanghai',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}})));
  const errors=(output.errors??[]).filter((e:any)=>e.severity==='error');
  if(errors.length) throw new Error(errors.map((e:any)=>e.formattedMessage).join('\n'));
  return output.contracts['TrustAnchor.sol'].TrustAnchor;
}
export class LocalChain {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly raw: ReturnType<typeof ganache.provider>, readonly provider: BrowserProvider, readonly contract: Contract, readonly address:string, readonly chainId:string) {}
  static async open(directory?:string) {
    if(directory) mkdirSync(directory,{recursive:true,mode:0o700});
    const raw=ganache.provider({logging:{quiet:true},chain:{chainId:1337,hardfork:'shanghai'},wallet:{deterministic:true,totalAccounts:2},...(directory?{database:{dbPath:join(directory,'evm')}}:{})});
    const provider=new BrowserProvider(raw as any,undefined,{cacheTimeout:-1});
    provider.pollingInterval=50;
    const signer=await provider.getSigner(0),artifact=compileAnchor();
    const manifest=directory?join(directory,'deployment.json'):null;
    let address:string;
    if(manifest && existsSync(manifest)) {
      const stored=JSON.parse(readFileSync(manifest,'utf8'));
      address=stored.address;
      const code=await provider.getCode(address);
      if(code==='0x' || hash(code)!==stored.code_hash) throw new Error('CHAIN_DEPLOYMENT_MISMATCH');
    } else {
      const deployed=await new ContractFactory(artifact.abi,artifact.evm.bytecode.object,signer).deploy();
      await deployed.waitForDeployment();
      address=await deployed.getAddress();
      if(manifest) writeFileSync(manifest,JSON.stringify({address,code_hash:hash(await provider.getCode(address)),compiler:solc.version()}),{mode:0o600});
    }
    const contract=new Contract(address,artifact.abi,signer);
    if((await contract.getFunction('writer')()).toLowerCase()!==(await signer.getAddress()).toLowerCase()) throw new Error('CHAIN_WRITER_MISMATCH');
    return new LocalChain(raw,provider,contract,address,(await provider.getNetwork()).chainId.toString());
  }
  async flush(trust:Trust) {
    const run=this.queue.then(async()=>{
      const local=trust.verifyLocal();
      if(!local.valid) throw new Error(local.reason);
      let count=Number(await this.contract.getFunction('count')());
      const rows=trust.receipts();
      if(count>rows.length) throw new Error('LOCAL_EVIDENCE_TRUNCATED');
      for(const r of rows) {
        if(r.seq<=count) {
          if((await this.contract.getFunction('hashes')(r.seq))!=='0x'+r.hash) throw new Error('CHAIN_HASH_MISMATCH');
          if(!r.anchor_json) {
            const events=await this.contract.queryFilter(this.contract.filters.Anchored!(r.seq),0,'latest');
            const event=events[0];
            if(!event) throw new Error('ANCHOR_EVENT_MISSING');
            const receipt=await this.provider.getTransactionReceipt(event.transactionHash);
            if(!receipt || receipt.status!==1) throw new Error('ANCHOR_RECEIPT_INVALID');
            this.save(trust,r,receipt.hash,receipt.blockNumber,receipt.blockHash);
          }
          continue;
        }
        const tx=await this.contract.getFunction('anchor')(r.seq,'0x'+r.previous,'0x'+r.hash);
        const receipt=await tx.wait(1,30000);
        if(!receipt || receipt.status!==1) throw new Error('ANCHOR_NOT_CONFIRMED');
        this.save(trust,r,receipt.hash,receipt.blockNumber,receipt.blockHash);
        count++;
      }
      return {status:'CONFIRMED_LOCAL_EVM',count,chain_id:this.chainId,contract:this.address};
    });
    this.queue=run.catch(()=>{});
    return run;
  }
  private save(trust:Trust,r:Receipt,tx:string,block:number,blockHash:string) {
    trust.db.prepare('UPDATE trust_evidence SET anchor_json=? WHERE id=?').run(JSON.stringify({chain_id:this.chainId,contract:this.address,transaction_hash:tx,block_number:block,block_hash:blockHash,status:'CONFIRMED_LOCAL_EVM'}),r.id);
  }
  async verify(trust:Trust) {
    const local=trust.verifyLocal();
    if(!local.valid) return {...local,chain_verified:false};
    const count=Number(await this.contract.getFunction('count')());
    const rows=trust.receipts();
    if(count>rows.length) return {valid:false,chain_verified:false,reason:'LOCAL_EVIDENCE_TRUNCATED'};
    for(const r of rows.slice(0,count)) {
      if((await this.contract.getFunction('hashes')(r.seq))!=='0x'+r.hash) return {valid:false,chain_verified:false,reason:'ONCHAIN_HASH_MISMATCH'};
      if(!r.anchor_json) return {valid:true,chain_verified:false,reason:'RECEIPT_RECOVERY_PENDING'};
      const a=JSON.parse(r.anchor_json);
      const receipt=await this.provider.getTransactionReceipt(a.transaction_hash);
      const block=receipt?await this.provider.getBlock(receipt.blockNumber):null;
      const eventOk=receipt?.logs.some(l=>{
        if(l.address.toLowerCase()!==this.address.toLowerCase()) return false;
        try {const event=this.contract.interface.parseLog(l);return event?.name==='Anchored' && Number(event.args.sequence)===r.seq && event.args.commitment==='0x'+r.hash && event.args.previous==='0x'+r.previous;}catch{return false;}
      });
      if(a.contract!==this.address || a.chain_id!==this.chainId || receipt?.status!==1 || receipt.blockHash!==a.block_hash || receipt.blockNumber!==a.block_number || block?.hash!==receipt.blockHash || !eventOk) return {valid:false,chain_verified:false,reason:'RECEIPT_MISMATCH'};
    }
    const head=await this.contract.getFunction('head')();
    if(head!=='0x'+(count?rows[count-1]!.hash:'0'.repeat(64))) return {valid:false,chain_verified:false,reason:'HEAD_MISMATCH'};
    return {valid:true,chain_verified:count===rows.length && count>0,count,local_count:rows.length,head,chain_id:this.chainId,contract:this.address,reason:count===0?'NO_EVIDENCE':count===rows.length?'VERIFIED_LOCAL_EVM':'ANCHOR_PENDING',network:'LOCAL_DEVELOPMENT_CHAIN'};
  }
  async close(){await this.queue;this.provider.destroy();await this.raw.disconnect();}
}
