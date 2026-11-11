import {createHash} from 'node:crypto';
import type {ChatPageSnapshot} from '../plugins/chatgpt-browser.js';
import {browserDecision} from './browser-controller.js';

const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const HEX_SHA=/^[a-f0-9]{64}$/;

/** A side-effect-free observation of a SINGLE still-pending original Send.
 * Never writes a receipt or authorizes a future Send. An old assistant reply
 * can remain visible below a newly submitted user turn; only a stable answer
 * with different bytes is a diagnostic candidate, not a recovered turn.
 * Distinct identical replies remain ambiguous until separately reconciled. */
export function assessPendingBrowserAnswer(input:{
  missionId:string;round:number;reservationEventId:number;
  reservationPromptSha256:string;latestUserSha256:string|null;
  lastObservedAnswerSha256:string|null;
  first:ChatPageSnapshot;second:ChatPageSnapshot;
}):{
  missionId:string;round:number;reservationEventId:number;
  originalPromptMatches:boolean;assistantCandidateSha256:string|null;
  stableMarkedReplyCandidate:boolean;priorAnswerRepeated:boolean;
  sendOrRecoveryAuthorized:false;receiptMutationPerformed:false;
  note:string;
}{
  const originalPromptMatches=HEX_SHA.test(input.reservationPromptSha256)&&
    input.latestUserSha256===input.reservationPromptSha256;
  const stable=originalPromptMatches&&input.first.url===input.second.url&&
    input.first.composerReady&&input.second.composerReady&&
    !input.first.generating&&!input.second.generating&&
    Boolean(input.first.lastAssistant.trim())&&
    input.first.lastAssistant===input.second.lastAssistant&&
    (!input.first.lastAssistantTurnId||!input.second.lastAssistantTurnId||
      input.first.lastAssistantTurnId===input.second.lastAssistantTurnId)&&
    browserDecision(input.second.lastAssistant)!=='UNMARKED';
  const candidateSha=stable?sha(input.second.lastAssistant):null;
  const priorAnswerRepeated=Boolean(candidateSha&&
    candidateSha===input.lastObservedAnswerSha256);
  // Without a previously settled assistant digest, even a stable marked
  // answer could be the old attached human conversation's last response.
  // The inspector cannot reconstruct missing pre-Send identity evidence.
  const stableMarkedReplyCandidate=Boolean(candidateSha&&
    input.lastObservedAnswerSha256&&HEX_SHA.test(input.lastObservedAnswerSha256)&&
    !priorAnswerRepeated);
  return {
    missionId:input.missionId,round:input.round,
    reservationEventId:input.reservationEventId,
    originalPromptMatches,
    assistantCandidateSha256:stableMarkedReplyCandidate?candidateSha:null,
    stableMarkedReplyCandidate,priorAnswerRepeated,
    sendOrRecoveryAuthorized:false,receiptMutationPerformed:false,
    note:stableMarkedReplyCandidate
      ?'Stable marked answer candidate differs from the previous committed answer. The original Send is still pending; do not replay or credit a round without the controller or explicit guarded recovery.'
      :priorAnswerRepeated
        ?'The previous committed assistant answer remains visible. This is not evidence that the pending request completed.'
        :'No distinct stable marked answer candidate with prior-response attribution was proven; preserve the original reservation without any Send or recovery.',
  };
}
