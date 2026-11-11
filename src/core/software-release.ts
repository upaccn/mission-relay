import {githubReleaseProbe,readGithubReleaseMainSha} from './goal-release-github.js';

const shaPattern=/^[0-9a-f]{40}$/;
const runPattern=/^[1-9][0-9]{4,19}$/;
export const SOFTWARE_CI_PLATFORMS=['ci-ubuntu','ci-macos','ci-windows'] as const;

export interface SoftwareReleaseReport {
  kind:'software-release-candidate';
  candidateSha:string;
  mainSha:string;
  ciRunId:string;
  qualified:boolean;
  platformChecks:{requirement:string;state:'PASS'|'FAIL';
    reference:string;proofSha256:string}[];
  /** A GitHub CI receipt does not attest a production Worker or Goal. */
  productionVerified:false;
  goalAcceptanceRequired:false;
}

/** Software-version qualification is independent of owner Goals, plans, PI
 * reviews, ChatGPT Sends and the private Mission SQLite schema. No release
 * state is written, no old evidence is replayed and no deployment is made.
 * Deployment and rollback still require the separate fenced runtime path. */
export async function inspectSoftwareReleaseCandidate(
  repository:string,candidateSha:string,runId:string,
  readMain:typeof readGithubReleaseMainSha=readGithubReleaseMainSha,
  makeProbe:typeof githubReleaseProbe=githubReleaseProbe,
):Promise<SoftwareReleaseReport>{
  if(!shaPattern.test(candidateSha)||!runPattern.test(runId))
    throw new Error('An exact source SHA and GitHub Actions run ID are required');
  const mainSha=readMain(repository);
  if(mainSha!==candidateSha)
    throw new Error('Software release candidate differs from GitHub main');
  const probe=makeProbe(repository,runId);
  const platformChecks:SoftwareReleaseReport['platformChecks']=[];
  for(const requirement of SOFTWARE_CI_PLATFORMS){
    const receipt=await probe.inspect(requirement,candidateSha);
    if(receipt.observedSha!==candidateSha||
      !/^[a-f0-9]{64}$/.test(receipt.proofSha256)||
      receipt.state!=='PASS'||
      !receipt.reference.startsWith('https://github.com/'))
      throw new Error('Software release CI did not prove all required platforms');
    platformChecks.push({requirement,state:'PASS',
      reference:receipt.reference,proofSha256:receipt.proofSha256});
  }
  if(readMain(repository)!==candidateSha)
    throw new Error('GitHub main changed during software release qualification');
  return {kind:'software-release-candidate',candidateSha,mainSha,ciRunId:runId,
    qualified:true,platformChecks,productionVerified:false,
    goalAcceptanceRequired:false};
}
