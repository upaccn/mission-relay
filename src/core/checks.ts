import { spawn, spawnSync } from 'node:child_process';
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

/** Kill an operator-owned verifier process tree, never the Mission Relay process.
 * POSIX checks run in a dedicated process group so a child holding inherited
 * pipes cannot outlive the timed-out check. Windows uses its native tree kill.
 * If the direct parent has already exited on Windows, descendants may remain;
 * the independent hard deadline below still fails the verification closed. */
function terminateCheckTree(child:ReturnType<typeof spawn>):void {
  if(child.pid===undefined) return;
  if(process.platform==='win32'){
    try{
      spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{
        stdio:'ignore',windowsHide:true,timeout:1500,
      });
    }catch{/* Still fail the check when native tree cleanup is unavailable. */}
    try{child.kill('SIGKILL');}catch{/* Already exited. */}
  }else {
    try{process.kill(-child.pid,'SIGKILL');}
    catch{try{child.kill('SIGKILL');}catch{/* Already exited. */}}
  }
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
      let timedOut=false, failedToSpawn=false,settled=false;
      const child=spawn(executable,args,{
        cwd:mission.workspace,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],
        detached:process.platform!=='win32',env:childEnvironment('check'),
      });
      const finish=(code:number|null)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        resolve({index:i,executable,passed:!failedToSpawn&&!timedOut&&code===0,
          exitCode:code,timedOut,outputSha256:hash.digest('hex')});
      };
      // A process can exit while its descendants keep stdout/stderr open.
      // Never await the streams past the configured verification deadline.
      const timer=setTimeout(()=>{
        timedOut=true;
        terminateCheckTree(child);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      },check.timeoutMs);
      child.stdout?.on('data',(chunk:Buffer)=>{if(!settled)hash.update(chunk);});
      child.stderr?.on('data',(chunk:Buffer)=>{if(!settled)hash.update(chunk);});
      child.once('error',()=>{failedToSpawn=true;finish(null);});
      child.once('close',code=>finish(code));
    });
    receipts.push(receipt);
    if(!receipt.passed) break;
  }
  return receipts;
}
