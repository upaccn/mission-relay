import {createHash} from 'node:crypto';
import type {Page} from 'playwriter';
import type {Store} from './store.js';
import {normalizeChatGPTUrl} from './chatgpt-handoff.js';
import {inspectChatPage,lastVisibleUserPrompt,lastVisibleUserPromptSha256} from '../plugins/chatgpt-browser.js';

/** Read an owner-started ChatGPT conversation; do not Send or open tabs.
 * The natural-language goal is seeded from the actual latest user message.
 * Native turnCount stays at zero until Relay itself submits a new prompt. */
export async function adoptConnectedConversation(
  store:Store,page:Page,targetUrl:string,browserId:string,
  options:{goal?:string;piEnabled?:boolean;stillAuthorized?:()=>boolean;
    onAdopted?:(missionId:string)=>void}={},
):Promise<{missionId:string;adoptedAnswerSha256:string}> {
  const url=normalizeChatGPTUrl(targetUrl);
  if(store.list().some(m=>store.chatLink(m.id)===url &&
    !['CANCELLED','COMPLETED'].includes(m.state)))
    throw new Error('This ChatGPT conversation already belongs to an active Mission');
  const first=await inspectChatPage(page,url);
  const user=await lastVisibleUserPrompt(page);
  const userSha=await lastVisibleUserPromptSha256(page);
  if(first.generating||!first.composerReady||!first.lastAssistant.trim()||!user||!userSha)
    throw new Error('Cannot adopt an empty or generating ChatGPT conversation');
  await new Promise(resolve=>setTimeout(resolve,3000));
  const second=await inspectChatPage(page,url);
  if(second.generating||!second.composerReady||second.lastAssistant!==first.lastAssistant||
    await lastVisibleUserPromptSha256(page)!==userSha)
    throw new Error('Existing ChatGPT reply changed before adoption; no Mission created');
  const goal=options.goal??`Continue the user-started ChatGPT task. Latest user request: ${user.slice(0,1250)}`;
  if(!goal.trim()||goal.length>1500)
    throw new Error('Adoption goal must be 1–1500 characters');
  const assistantSha256=createHash('sha256').update(second.lastAssistant).digest('hex');
  const requestKey=`chat-adopt-${createHash('sha256').update(browserId+'\n'+url).digest('hex')}`;
  const mission=store.atomic(()=>{
    if(options.stillAuthorized&&!options.stillAuthorized())
      throw new Error('Chrome profile watch was revoked before adoption');
    const result=store.adoptHumanChat({goal,
      acceptance:['Assess the existing conversation and finish remaining read-only work with verifiable evidence'],
      workspace:'',sandbox:'read-only',mode:'supervised',maxTurns:8,requestKey,checks:[]},
      url,browserId,{userSha256:userSha,assistantSha256,summary:second.lastAssistant});
    if(options.piEnabled)store.setMeta(`pi.autopilot.enabled.${result.id}`,'1');
    options.onAdopted?.(result.id);
    return result;
  });
  return {missionId:mission.id,adoptedAnswerSha256:assistantSha256};
}
