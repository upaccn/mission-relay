import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Mission, VerificationCheck } from './types.js';
import { childEnvironment } from './child-env.js';

export interface CheckReceipt {
  index: number;
  executable: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  outputSha256: string;
}

/** Execute only commands configured by the operator at mission creation. */
export async function runChecks(mission: Mission):Promise<CheckReceipt[]> {
  const receipts:CheckReceipt[]=[];
  for(let i=0;i<mission.checks.length;i++) {
    const check:VerificationCheck=mission.checks[i]!;
    const [executable,...args]=check.argv;
    if(!executable) throw new Error('Verification check has no executable');
    const receipt=await new Promise<CheckReceipt>(resolve=>{
      const hash=createHash('sha256');
      let timedOut=false, failedToSpawn=false;
      const child=spawn(executable,args,{
        cwd:mission.workspace,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:childEnvironment('check'),
      });
      const timer=setTimeout(()=>{timedOut=true;child.kill();},check.timeoutMs);
      child.stdout?.on('data',(chunk:Buffer)=>{hash.update(chunk);});
      child.stderr?.on('data',(chunk:Buffer)=>{hash.update(chunk);});
      child.once('error',()=>{failedToSpawn=true;});
      child.once('close',code=>{
        clearTimeout(timer);
        resolve({index:i,executable,passed:!failedToSpawn&&!timedOut&&code===0,
          exitCode:code,timedOut,outputSha256:hash.digest('hex')});
      });
    });
    receipts.push(receipt);
    if(!receipt.passed) break;
  }
  return receipts;
}
