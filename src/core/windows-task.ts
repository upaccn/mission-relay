import {spawnSync} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';

export interface TaskStatus {
  installed:boolean;taskVerified:boolean;taskState:string;recoverySchedule:boolean;
  pollerPresent:boolean;pollerPid:number;transportHealth:string;
  workerProcessVerified?:boolean;
  workerProcessStartedAt?:string|null;
  workerParentStartedAt?:string|null;
}

/** Read-only readback of the enrolled Windows Scheduled Task, used inside the
 * atomic verified maintenance-drain release. Never starts or changes a task. */
export function enrolledTaskStatus(entry:string):TaskStatus{
  const script=join(dirname(dirname(resolve(entry))),'scripts','windows','telegram-task.ps1');
  const literal=script.replaceAll("'","''");
  const result=spawnSync('pwsh',['-NoProfile','-NonInteractive','-Command',
    `& '${literal}' -Action Status | ConvertTo-Json -Compress -Depth 4`],{
    encoding:'utf8',timeout:20_000,maxBuffer:64*1024,windowsHide:true,shell:false,
  });
  if(result.error||result.status!==0||!result.stdout)
    throw new Error('Enrolled GMK Scheduled Task read-only identity probe unavailable');
  let read:unknown;
  try{read=JSON.parse(result.stdout);}catch{
    throw new Error('Enrolled GMK Scheduled Task returned invalid readback');
  }
  if(!read||typeof read!=='object'||Array.isArray(read))
    throw new Error('Enrolled GMK Scheduled Task returned invalid status');
  return read as TaskStatus;
}
