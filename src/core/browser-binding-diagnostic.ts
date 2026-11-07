import {createHash} from 'node:crypto';
import type {ChatBrowserTurn} from './store.js';
import {normalizeChatGPTUrl} from './chatgpt-handoff.js';

export interface EnabledChatCandidate {
  urlSha256:string;
  lastUserSha256:string|null;
  duplicate?:boolean;
}

/** Content-free diagnosis of an existing pinned ChatGPT conversation. This
 * does NOT inspect an assistant answer or authorize a Send or recovery.
 * Playwriter cannot distinguish a closed, navigated, or extension-disabled
 * tab when the exact conversation is absent from the connected inventory. */
export function inspectBrowserBinding(input:{
  missionId:string;missionState:string;turnCount:number;
  linkedUrl:string;receipt:ChatBrowserTurn|null;
  enabledChatCandidates:EnabledChatCandidate[];
}):{
  missionId:string;missionState:string;turnCount:number;
  browserReceiptStatus:ChatBrowserTurn['status']|null;
  enabledChatTabs:number;matchingLinkedTabs:number;
  binding:'exact_connected'|'duplicate_connected'|'not_exposed';
  latestUserMatchesPendingPrompt:boolean|null;
  pendingNewConversation:boolean;
  independentlyVerifiedFinalAnswer:false;
  sendOrRecoveryAuthorized:false;
  note:string;
}{
  const expectedSha=createHash('sha256').update(
    normalizeChatGPTUrl(input.linkedUrl)).digest('hex');
  const matches=input.enabledChatCandidates.filter(c=>c.urlSha256===expectedSha);
  const exact=matches.length===1&&!matches[0]?.duplicate;
  const pending=input.receipt?.status==='reserved'||input.receipt?.status==='uncertain';
  const visibleUser=exact?matches[0]?.lastUserSha256:null;
  const latestUserMatchesPendingPrompt=pending&&visibleUser
    ?visibleUser===input.receipt!.promptSha256:null;
  const binding=exact?'exact_connected':
    matches.length?'duplicate_connected':'not_exposed';
  const note=binding==='not_exposed'
    ?'Linked ChatGPT conversation is not exposed to Playwriter; closed, navigated or extension-disabled tabs cannot be distinguished. No new tab or Send was created.'
    :binding==='duplicate_connected'
    ?'The exact linked conversation appears more than once; recovery requires one unique authorized tab.'
    :'Exact linked tab is connected. A prompt match alone never proves the original Send or final assistant answer completed; inspect its stable full answer separately.';
  return {
    missionId:input.missionId,missionState:input.missionState,
    turnCount:input.turnCount,browserReceiptStatus:input.receipt?.status??null,
    enabledChatTabs:input.enabledChatCandidates.length,
    matchingLinkedTabs:matches.length,binding,
    latestUserMatchesPendingPrompt,
    pendingNewConversation:pending&&input.receipt?.newConversation===true,
    independentlyVerifiedFinalAnswer:false,
    sendOrRecoveryAuthorized:false,note,
  };
}
