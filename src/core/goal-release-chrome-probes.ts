import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import type {Page} from 'playwriter';
import type {Store} from './store.js';
import {InsufficientReleaseEvidenceError,type ReleaseProbe,type EvidenceReadback} from './goal-release.js';
import {inspectGoalRequestLedger} from './request-ledger.js';
import {inspectGoalChromeTenToElevenHistory} from './goal-release-chrome-history.js';
import {MAX_RELAY_CHAT_TURNS,LEGACY_RELAY_CHAT_TURNS} from './chat-limits.js';
import {inspectPiEvidence} from './pi-evidence.js';
import {GoalLedger} from './goal-store.js';
import {requireSettledReleaseCustody} from './goal-release.js';
import {stateHome} from './paths.js';
import {readReleaseWorkerIdentity,withStableReleaseWorkerIdentity,
  type ReleaseWorkerIdentity} from './goal-release-runtime.js';
import {normalizeChatGPTUrl} from './chatgpt-handoff.js';
import {chatTabTargetSha256,inspectChatPage,lastVisibleUserPromptSha256} from '../plugins/chatgpt-browser.js';
import {withReadOnlyDeadline} from './read-only-deadline.js';
import {retireSupersededRelayTab} from './browser-controller.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const SHA40=/^[a-f0-9]{40}$/;
const SHA64=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9-]{36}$/i;
const FINAL=/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/;
const CAPTURE_WINDOW_MS=20*60*1000;
export type TrustedChromeTabObservation={
  urlSha256:string;targetSha256:string;promptSha256:string;answerSha256:string;
  assistantTurnSha256:string|null;userCount:number;assistantCount:number;
};
type BoundaryWitness={
  /** Historical on-disk kind retained for exact old-proof compatibility.
   * The captured current boundary is 8->9, not an allowed ninth same-chat Send. */
  kind:'ten-to-eleven';version:1;goalId:string;missionId:string;sourceSha:string;
  observedAt:string;sourceObservationEventId:number;sourceDecisionEventId:number;
  destinationReservationEventId:number;destinationMigrationEventId:number;
  destinationObservationEventId:number;source:TrustedChromeTabObservation;destination:TrustedChromeTabObservation;
};
type RetirementWitness={
  kind:'tab-retirement';version:1;goalId:string;missionId:string;sourceSha:string;
  observedAt:string;retirementEventId:number;migrationEventId:number;
  observationEventId:number;sourceTargetSha256:string;destinationTargetSha256:string;
  sourceUrlSha256:string;destinationUrlSha256:string;
  beforeTargets:string[];afterTargets:string[];
};
type Witness=BoundaryWitness|RetirementWitness;
type FileWitness<T extends Witness>={witness:T;digest:string};

function privateDirectory(root:string,goalId:string):string {
  if(!UUID.test(goalId))throw new Error('Invalid Goal identity for private Chrome evidence');
  return join(resolve(root),'chrome-custody',goalId);
}
/** Write-once, private, content-addressed original browser evidence. No raw
 * Chat URL, model text, request key, Chrome Target or credentials are stored. */
function saveWitness(root:string,witness:Witness):string {
  const dir=privateDirectory(root,witness.goalId),raw=JSON.stringify(witness),digest=hash(raw);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const path=join(dir,`${witness.kind}-${digest}.json`);
  try{writeFileSync(path,raw,{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'||readFileSync(path,'utf8')!==raw)
      throw error;
  }
  return digest;
}
function loadWitnesses<T extends Witness>(root:string,goalId:string,kind:T['kind']):FileWitness<T>[] {
  const dir=privateDirectory(root,goalId);
  if(!existsSync(dir))return [];
  const result:FileWitness<T>[]=[];
  for(const filename of readdirSync(dir).filter(x=>x.startsWith(`${kind}-`))){
    if(!new RegExp(`^${kind}-[a-f0-9]{64}\\.json$`).test(filename))
      throw new Error('Unrecognized Chrome witness filename');
    const file=join(dir,filename);
    if(!lstatSync(file).isFile())throw new Error('Chrome witness must be a regular private file');
    const raw=readFileSync(file,'utf8');
    if(raw.length>16_384||hash(raw)!==filename.slice(kind.length+1,-5))
      throw new Error('Chrome witness content digest mismatch');
    const value=JSON.parse(raw) as Witness;
    if(value.kind!==kind||value.version!==1||value.goalId!==goalId||
      !SHA40.test(value.sourceSha)||!Number.isFinite(Date.parse(value.observedAt)))
      throw new Error('Chrome witness identity or version mismatch');
    result.push({witness:value as T,digest:hash(raw)});
  }
  return result;
}
/** Historical physical observations remain valid for their immutable event.
 * The Release Gate itself supplies a fresh 24-hour inspection receipt.
 * Reject a witness fabricated long before or after the original browser
 * event, rather than expiring genuine evidence from a multi-day Goal. */
function requireCaptureTime(timestamp:string,eventTime:string):void {
  const captured=Date.parse(timestamp),observed=Date.parse(eventTime);
  if(!Number.isFinite(captured)||!Number.isFinite(observed)||
    captured>Date.now()+30_000||
    captured<observed-30_000||captured>observed+CAPTURE_WINDOW_MS)
    throw new Error('Chrome witness was not captured at its original physical event');
}
function requireTab(tab:TrustedChromeTabObservation):void {
  if(!tab||!Object.values(tab).length||
    !['urlSha256','targetSha256','promptSha256','answerSha256'].every(k=>
      SHA64.test(String(tab[k as keyof TrustedChromeTabObservation])))||
    (tab.assistantTurnSha256!==null&&!SHA64.test(tab.assistantTurnSha256))||
    !Number.isInteger(tab.userCount)||tab.userCount<1||
    !Number.isInteger(tab.assistantCount)||tab.assistantCount<1)
    throw new Error('Chrome witness lacks valid physical Target and full transcript hashes');
}

/** Read TWO stable snapshots in the pinned physical Page, before tab retirement.
 * No JS injection, navigation, Send or owner tab close is performed here. */
export async function observeTrustedChromeTab(page:Page,url:string):Promise<TrustedChromeTabObservation> {
  const expected=normalizeChatGPTUrl(url);
  const sample=async()=>{
    const state=await withReadOnlyDeadline(inspectChatPage(page,expected),15000);
    const prompt=await withReadOnlyDeadline(lastVisibleUserPromptSha256(page),15000);
    const target=await withReadOnlyDeadline(chatTabTargetSha256(page),8000);
    return {state,prompt,target};
  };
  const first=await sample(),second=await sample();
  if(first.state.url!==expected||second.state.url!==expected||
    first.state.generating||second.state.generating||
    !first.state.composerReady||!second.state.composerReady||
    !FINAL.test(second.state.lastAssistant.trim())||
    !first.target||first.target!==second.target||!first.prompt||
    first.prompt!==second.prompt||
    first.state.lastAssistant!==second.state.lastAssistant||
    first.state.userCount!==second.state.userCount||
    first.state.assistantCount!==second.state.assistantCount||
    first.state.lastAssistantTurnId!==second.state.lastAssistantTurnId)
    throw new Error('Chrome source or destination physical tab is not stable and complete');
  return {urlSha256:hash(expected),targetSha256:second.target,
    promptSha256:second.prompt,answerSha256:hash(second.state.lastAssistant),
    assistantTurnSha256:second.state.lastAssistantTurnId?
      hash(second.state.lastAssistantTurnId):null,
    userCount:second.state.userCount,assistantCount:second.state.assistantCount};
}

/** Called by the existing PI controller immediately after an observed
 * rollover, BEFORE its ordinary old-tab cleanup and BEFORE the new Chat PI review.
 * The final ReleaseProbe still requires the later matching PI decision. */
export async function captureGoalChromeBoundary(input:{
  store:Store;goalId:string;missionId:string;sourcePage:Page;destinationPage:Page;
  sourceUrl:string;destinationUrl:string;sourceSha:string;privateRoot?:string;
}):Promise<string> {
  const {store,goalId,missionId}=input;
  if(!SHA40.test(input.sourceSha)||input.sourcePage===input.destinationPage)
    throw new Error('Chrome boundary needs distinct physical tabs and a verified source revision');
  const report=inspectPiEvidence(store,missionId);
  const latest=report.rounds.at(-1),prior=report.rounds.at(-2);
  if(!report.ledgerConsistent||!latest||!prior||
    ![MAX_RELAY_CHAT_TURNS,LEGACY_RELAY_CHAT_TURNS].includes(prior.chatTurn)||
    latest.chatTurn!==1||latest.round!==prior.round+1||
    !prior.decisionShaMatches||prior.decisionEventId===null||
    latest.decisionEventId!==null||latest.reservedEventId===null||
    store.get(missionId).state!=='PAUSED')
    throw new Error('No pending PI-reviewed chat rollover boundary to capture');
  const ledger=inspectGoalRequestLedger(store,goalId);
  if(!ledger.ledgerConsistent||!ledger.missionIds.includes(missionId)||
    ledger.quarantineEventIds.length||ledger.unattributedEventIds.length)
    throw new Error('Chrome boundary original Goal custody is not consistent');
  const source=ledger.requests.find(r=>r.observationEventId===prior.observedEventId);
  const destination=ledger.requests.find(r=>r.observationEventId===latest.observedEventId);
  const migrations=store.events(missionId).filter(e=>e.type==='chatgpt.browser_migrated'&&
    e.id>latest.reservedEventId!&&e.id<latest.observedEventId);
  const migration=migrations[0],origin=store.events(missionId).filter(e=>
    e.type==='chatgpt.browser_migrated'&&e.id<prior.observedEventId&&
    (e.payload as {newUrlSha256?:string}).newUrlSha256===source?.sourceChatUrlSha256).at(-1);
  if(migrations.length!==1||!migration||!origin||!source||!destination||
    source.status!=='observed'||destination.observationEventId===null||
    destination.reservationEventId!==latest.reservedEventId||
    destination.status!=='observed'||destination.decisionEventId!==null||
    source.decisionEventId!==prior.decisionEventId||
    destination.sourceChatUrlSha256!==source.sourceChatUrlSha256||
    destination.destinationChatUrlSha256!==hash(normalizeChatGPTUrl(input.destinationUrl))||
    source.sourceChatUrlSha256!==hash(normalizeChatGPTUrl(input.sourceUrl)))
    throw new Error('Original source, destination, reservation or migration does not agree');
  const [oldTab,newTab]=await Promise.all([
    observeTrustedChromeTab(input.sourcePage,input.sourceUrl),
    observeTrustedChromeTab(input.destinationPage,input.destinationUrl)]);
  if(oldTab.targetSha256===newTab.targetSha256||
    oldTab.promptSha256!==source.promptSha256||oldTab.answerSha256!==source.answerSha256||
    newTab.promptSha256!==destination.promptSha256||
    newTab.answerSha256!==destination.answerSha256||
    (origin.payload as {newTabTargetSha256?:string}).newTabTargetSha256!==oldTab.targetSha256||
    (migration.payload as {newTabTargetSha256?:string}).newTabTargetSha256!==newTab.targetSha256)
    throw new Error('Chrome physical Target or original request/reply differs from controller ledger');
  return saveWitness(input.privateRoot??stateHome(),{
    kind:'ten-to-eleven',version:1,goalId,missionId,sourceSha:input.sourceSha,
    observedAt:new Date().toISOString(),
    sourceObservationEventId:prior.observedEventId,
    sourceDecisionEventId:prior.decisionEventId,
    destinationReservationEventId:destination.reservationEventId,
    destinationMigrationEventId:migration.id,
    destinationObservationEventId:latest.observedEventId,
    source:oldTab,destination:newTab,
  });
}

/** Only physical Target identity is queried for unrelated pages. Never read
 * their URLs, DOM, text or other user data. Unknown or duplicate Targets
 * fail closed so physical tab preservation cannot be inferred. */
async function targetInventory(page:Page):Promise<string[]> {
  const pages=page.context().pages().filter(p=>!p.isClosed());
  const values=await Promise.all(pages.map(async p=>
    withReadOnlyDeadline(chatTabTargetSha256(p),8000)));
  if(values.some(x=>!x)||new Set(values).size!==values.length)
    throw new Error('Unidentified or duplicated enabled Chrome physical Target');
  return values as string[];
}
function assertOnlySourceRetired(before:string[],after:string[],source:string,destination:string):void {
  if(source===destination||!before.includes(source)||!before.includes(destination)||
    after.includes(source)||!after.includes(destination)||
    before.length!==after.length+1||
    before.some(t=>t!==source&&!after.includes(t))||
    after.some(t=>!before.includes(t))||
    new Set(before).size!==before.length||new Set(after).size!==after.length)
    throw new Error('A user tab changed or retired physical Chrome Target is still open');
}

/** Safe replacement for same-Mission Goal cleanup only. A failed close never
 * writes a retirement event. A failed inventory leaves the old tab untouched.
 * Old non-Goal cleanup retains the existing normal path. */
export async function retireGoalOwnedTab(input:{
  store:Store;goalId:string;missionId:string;sourcePage:Page;destinationPage:Page;
  sourceUrl:string;destinationUrl:string;sourceSha:string;privateRoot?:string;
}):Promise<boolean>{
  const {store,missionId,sourcePage,destinationPage,sourceUrl,destinationUrl}=input;
  if(!SHA40.test(input.sourceSha)||
    new GoalLedger(store).missionGoalId(missionId)!==input.goalId||
    !store.canRetireOwnedChatTab(missionId,sourceUrl,destinationUrl))return false;
  let before:string[],sourceTarget:string,destinationTarget:string;
  try{
    before=await targetInventory(sourcePage);
    const hashes=await Promise.all([
      chatTabTargetSha256(sourcePage),chatTabTargetSha256(destinationPage)]);
    if(!hashes[0]||!hashes[1]||!before.includes(hashes[0])||!before.includes(hashes[1]))
      return false;
    sourceTarget=hashes[0];destinationTarget=hashes[1];
    const history=store.events(missionId).filter(e=>e.type==='chatgpt.browser_migrated');
    const oldOrigin=history.filter(e=>
      (e.payload as {newUrlSha256?:string}).newUrlSha256===hash(normalizeChatGPTUrl(sourceUrl))).at(-1);
    const newMigration=history.at(-1);
    // The original Relay-created physical Target (not an owner-opened clone
    // of the same URL) is the ONLY page this cleanup may close.
    if(sourcePage===destinationPage||
      sourcePage.url().replace(/\/$/,'')!==normalizeChatGPTUrl(sourceUrl)||
      destinationPage.url().replace(/\/$/,'')!==normalizeChatGPTUrl(destinationUrl)||
      (oldOrigin?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==sourceTarget||
      (newMigration?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==destinationTarget)
      return false;
  }catch{return false;}
  // Re-read every enabled physical Target after initial provenance checks.
  // A tab replacement or unexpected owner-tab movement between observation
  // and retirement is not authority to close a Page, even at the same URL.
  try{
    const current=await targetInventory(sourcePage);
    if(current.length!==before.length||
      current.some(t=>!before.includes(t))||
      await chatTabTargetSha256(sourcePage)!==sourceTarget||
      await chatTabTargetSha256(destinationPage)!==destinationTarget)
      return false;
  }catch{return false;}
  if(!await retireSupersededRelayTab(sourcePage,destinationPage,sourceUrl))return false;
  try{
    const after=await targetInventory(destinationPage);
    assertOnlySourceRetired(before,after,sourceTarget,destinationTarget);
    store.recordOwnedChatTabRetired(missionId,sourceUrl,destinationUrl);
    const event=store.events(missionId).filter(e=>
      e.type==='chatgpt.browser_tab_retired'&&
      (e.payload as {retiredUrlSha256?:string}).retiredUrlSha256===
        hash(normalizeChatGPTUrl(sourceUrl))).at(-1);
    if(!event)throw new Error('Verified original retirement event disappeared');
    const p=event.payload as {migrationEventId:number;observedEventId:number};
    saveWitness(input.privateRoot??stateHome(),{
      kind:'tab-retirement',version:1,goalId:input.goalId,missionId,
      sourceSha:input.sourceSha,observedAt:new Date().toISOString(),
      retirementEventId:event.id,migrationEventId:p.migrationEventId,
      observationEventId:p.observedEventId,
      sourceTargetSha256:sourceTarget,destinationTargetSha256:destinationTarget,
      sourceUrlSha256:hash(normalizeChatGPTUrl(sourceUrl)),
      destinationUrlSha256:hash(normalizeChatGPTUrl(destinationUrl)),
      beforeTargets:before.sort(),afterTargets:after.sort(),
    });
    return true;
  }catch{
    // The old tab may already be gone. Never manufacture its physical proof.
    console.error('Relay tab closed, but physical custody could not be independently certified');
    return false;
  }
}

/** Pure, independently checkable contract for persisted original readbacks.
 * Tests use synthetic private witnesses; real code captures only from Pages. */
export function validateChromeWitness(store:Store,goalId:string,targetSha:string,
  witness:Witness):void{
  if(witness.goalId!==goalId||witness.sourceSha!==targetSha||
    !SHA40.test(targetSha))throw new Error('Chrome witness belongs to a different Goal or source SHA');
  const event=store.events(witness.missionId).find(e=>e.id===
    (witness.kind!=='tab-retirement'
      ?witness.destinationObservationEventId:witness.retirementEventId));
  if(!event)throw new Error('Chrome witness original observation event is missing');
  requireCaptureTime(witness.observedAt,event.createdAt);
  const ledger=inspectGoalRequestLedger(store,goalId);
  if(!ledger.ledgerConsistent||ledger.quarantineEventIds.length||
    ledger.unattributedEventIds.length||
    ledger.requests.some(r=>r.status!=='observed'||r.decisionEventId===null))
    throw new Error('Goal has missing, duplicate, reconciled or unreviewed original requests');
  if(!ledger.missionIds.includes(witness.missionId))
    throw new Error('Chrome witness Mission is not part of the approved Goal');
  if(witness.kind!=='tab-retirement'){
    requireTab(witness.source);requireTab(witness.destination);
    const history=inspectGoalChromeTenToElevenHistory(store,goalId);
    const rotation=history.rotations.find(r=>
      r.sourceObservationEventId===witness.sourceObservationEventId&&
      r.sourceDecisionEventId===witness.sourceDecisionEventId&&
      r.reservationEventId===witness.destinationReservationEventId&&
      r.migrationEventId===witness.destinationMigrationEventId&&
      r.observationEventId===witness.destinationObservationEventId);
    const source=ledger.requests.find(r=>r.observationEventId===witness.sourceObservationEventId);
    const dest=ledger.requests.find(r=>r.observationEventId===witness.destinationObservationEventId);
    const e=store.events(witness.missionId);
    const migration=e.find(v=>v.id===witness.destinationMigrationEventId);
    const origin=e.filter(v=>v.type==='chatgpt.browser_migrated'&&
      v.id<witness.sourceObservationEventId&&
      (v.payload as {newUrlSha256?:string}).newUrlSha256===witness.source.urlSha256).at(-1);
    if(!rotation||!rotation.custodyConsistent||
      !history.custodyConsistent||!rotation.sourceTargetFingerprintRecorded||
      !rotation.destinationTargetFingerprintRecorded||
      !source||!dest||source.status!=='observed'||dest.status!=='observed'||
      source.decisionEventId!==witness.sourceDecisionEventId||
      dest.decisionEventId!==rotation.decisionEventId||
      source.promptSha256!==witness.source.promptSha256||
      source.answerSha256!==witness.source.answerSha256||
      source.sourceChatUrlSha256!==witness.source.urlSha256||
      dest.promptSha256!==witness.destination.promptSha256||
      dest.answerSha256!==witness.destination.answerSha256||
      dest.destinationChatUrlSha256!==witness.destination.urlSha256||
      witness.source.targetSha256===witness.destination.targetSha256||
      (origin?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==witness.source.targetSha256||
      (migration?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==witness.destination.targetSha256)
      throw new Error('Chrome rollover original requests, replies, PI or physical Targets are inconsistent');
  }else {
    const e=store.events(witness.missionId);
    const receipt=e.find(v=>v.id===witness.retirementEventId&&
      v.type==='chatgpt.browser_tab_retired');
    const p=receipt?.payload as {migrationEventId?:number;observedEventId?:number;
      retiredUrlSha256?:string;activeUrlSha256?:string}|undefined;
    const origin=e.filter(v=>v.type==='chatgpt.browser_migrated'&&
      v.id<(witness.migrationEventId)&&
      (v.payload as {newUrlSha256?:string}).newUrlSha256===witness.sourceUrlSha256).at(-1);
    const dest=e.find(v=>v.id===witness.migrationEventId&&
      v.type==='chatgpt.browser_migrated');
    if(!ledger.verifiedTabRetirementEventIds.includes(witness.retirementEventId)||
      !receipt||p?.migrationEventId!==witness.migrationEventId||
      p.observedEventId!==witness.observationEventId||
      p.retiredUrlSha256!==witness.sourceUrlSha256||
      p.activeUrlSha256!==witness.destinationUrlSha256||
      (origin?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==witness.sourceTargetSha256||
      (dest?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==witness.destinationTargetSha256||
      e.some(v=>v.type==='chatgpt.browser_reserved'&&v.id>witness.migrationEventId&&
        v.id<witness.retirementEventId)||
      !SHA64.test(witness.sourceTargetSha256)||!SHA64.test(witness.destinationTargetSha256)||
      witness.beforeTargets.some(x=>!SHA64.test(x))||
      witness.afterTargets.some(x=>!SHA64.test(x)))
      throw new Error('Tab retirement original controller custody is invalid');
    assertOnlySourceRetired(witness.beforeTargets,witness.afterTargets,
      witness.sourceTargetSha256,witness.destinationTargetSha256);
  }
}

/** This isolated readback contract checks original physical observations
 * against a NOW independently reconstructed Goal ledger. It never sends a
 * prompt, retries, marks PI PASS or invents missing physical evidence.
 * Production can reach it only after runtime-provenance validation. */
export function inspectStoredChromeWitnesses(store:Store,goalId:string,root:string,
  requirement:string,targetSha:string,runtimeIdentity?:ReleaseWorkerIdentity):EvidenceReadback {
  if(!['chrome-10-to-11','relay-tab-retirement'].includes(requirement))
    throw new Error('Unapproved trusted Chrome ReleaseProbe requirement');
  if(runtimeIdentity&&runtimeIdentity.source.sourceSha!==targetSha)
    throw new Error('Chrome physical observations cannot attest a different Worker revision');
  requireSettledReleaseCustody(store,goalId);
  const kind=requirement==='chrome-10-to-11'?'ten-to-eleven':'tab-retirement';
  const proofs=loadWitnesses(root,goalId,kind)
    .filter(x=>x.witness.sourceSha===targetSha);
  // Retain earlier revision evidence without treating it as a new target's
  // receipt. A new release SHA needs its own fresh physical observations.
  if(!proofs.length)
    throw new InsufficientReleaseEvidenceError('No independent physical Chrome witness for this source SHA');
  // A single failed or tampered witness never gets skipped in favor of a
  // convenient other PASS candidate. The target revision must be coherent.
  for(const proof of proofs)validateChromeWitness(store,goalId,targetSha,proof.witness);
  if(kind!=='tab-retirement'){
    const history=inspectGoalChromeTenToElevenHistory(store,goalId);
    const witnessed=proofs.map(p=>(p.witness as BoundaryWitness).destinationObservationEventId);
    const unique=new Set(witnessed);
    // Every boundary of this exact kind must have its own physical proof.
    // One genuine historical witness must never certify later unwitnessed
    // rollovers, nor may duplicate receipts stand in for a missing one.
    if(!history.custodyConsistent||unique.size!==proofs.length||
      proofs.length>history.rotations.length)
      throw new Error('Every Goal audited rollover requires unique, non-contradictory physical evidence');
    if(history.rotations.length!==proofs.length||
      history.rotations.some(r=>!unique.has(r.observationEventId)))
      throw new InsufficientReleaseEvidenceError(
        'Every Goal audited rollover requires its own physical Chrome witness');
  }else{
    const documented=inspectGoalRequestLedger(store,goalId).verifiedTabRetirementEventIds;
    const observed=new Set(proofs.map(p=>(p.witness as RetirementWitness).retirementEventId));
    // One physical witness per original retirement. Two independently
    // content-addressed files for the same event are contradictory, even if
    // both individually match the append-only controller event. They must
    // never be counted as two separate retired physical tabs.
    if(observed.size!==proofs.length||proofs.length>documented.length)
      throw new Error('Duplicate or conflicting physical tab retirement witnesses');
    if(documented.some(eventId=>!observed.has(eventId)))
      throw new InsufficientReleaseEvidenceError(
        'A Goal tab retirement lacks its own physical Chrome witness');
  }
  // Surface the *validated* event identities in the top-level receipt, not
  // just their witness digests. The original private witnesses remain the
  // source of truth; missing or substituted events already fail validation.
  const eventReferences=proofs.map(({witness,digest})=>witness.kind!=='tab-retirement'
    ?{witnessSha256:digest,missionId:witness.missionId,
      sourceObservationEventId:witness.sourceObservationEventId,
      sourceDecisionEventId:witness.sourceDecisionEventId,
      destinationReservationEventId:witness.destinationReservationEventId,
      destinationMigrationEventId:witness.destinationMigrationEventId,
      destinationObservationEventId:witness.destinationObservationEventId}
    :{witnessSha256:digest,missionId:witness.missionId,
      retirementEventId:witness.retirementEventId,
      migrationEventId:witness.migrationEventId,
      observationEventId:witness.observationEventId})
    .sort((a,b)=>a.witnessSha256.localeCompare(b.witnessSha256));
  const original=JSON.stringify({version:1,probeVersion:1,requirement,
    scenario:kind,goalId,targetSha,
    expectedOutcome:'PASS',observedOutcome:'PASS',
    evidenceProvenance:'physical-chrome-witnesses-and-original-sqlite-request-ledger',
    runtimeIdentity:runtimeIdentity??null,
    eventReferences,
    evidence:proofs.map(x=>x.digest).sort(),
    ledgerDigest:hash(JSON.stringify(inspectGoalRequestLedger(store,goalId))),
    observedAt:new Date().toISOString()});
  const proofSha256=hash(original),dir=privateDirectory(root,goalId);
  const name=join(dir,`inspection-${proofSha256}.json`);
  try{writeFileSync(name,original,{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'||readFileSync(name,'utf8')!==original)
      throw error;
  }
  return {state:'PASS',reference:`chrome-readback://${proofSha256}`,
    proofSha256,observedSha:targetSha} satisfies EvidenceReadback;
}

/** Only this controller-owned adapter can supply Chrome Release Gate receipts.
 * Its entrypoint must be the actual checked, compiled release binary. */
export function trustedChromeReleaseProbe(store:Store,goalId:string,root=stateHome(),
  entry=process.argv[1]):ReleaseProbe {
  return {source:'chrome-readback',inspect:async(requirement,targetSha)=>{
    return withStableReleaseWorkerIdentity(
      ()=>readReleaseWorkerIdentity(store,targetSha,entry),
      before=>inspectStoredChromeWitnesses(store,goalId,root,requirement,targetSha,before));
  }};
}
