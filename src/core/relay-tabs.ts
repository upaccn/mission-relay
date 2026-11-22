import {createHash} from 'node:crypto';
import type {Page} from 'playwriter';
import type {Store} from './store.js';
import {normalizeChatGPTUrl} from './chatgpt-handoff.js';
import {chatTabTargetSha256} from '../plugins/chatgpt-browser.js';
import {withReadOnlyDeadline} from './read-only-deadline.js';
import {retireSupersededRelayTab} from './browser-controller.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');

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

/** Close ONLY the Relay-created source tab of a settled Chat rollover
 * (AGENTS invariant 9). The physical Target recorded at migration must match
 * both before and after the inventory re-read; any owner tab movement, URL
 * change or unidentified Target keeps every tab open. Returns true only when
 * exactly the source Target disappeared and the retirement was recorded. */
export async function retireOwnedRelayTab(input:{
  store:Store;missionId:string;sourcePage:Page;destinationPage:Page;
  sourceUrl:string;destinationUrl:string;
}):Promise<boolean>{
  const {store,missionId,sourcePage,destinationPage,sourceUrl,destinationUrl}=input;
  if(!store.canRetireOwnedChatTab(missionId,sourceUrl,destinationUrl))return false;
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
    if(sourcePage===destinationPage||
      sourcePage.url().replace(/\/$/,'')!==normalizeChatGPTUrl(sourceUrl)||
      destinationPage.url().replace(/\/$/,'')!==normalizeChatGPTUrl(destinationUrl)||
      (oldOrigin?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==sourceTarget||
      (newMigration?.payload as {newTabTargetSha256?:string}|undefined)?.newTabTargetSha256!==destinationTarget)
      return false;
    const current=await targetInventory(sourcePage);
    if(current.length!==before.length||current.some(t=>!before.includes(t))||
      await chatTabTargetSha256(sourcePage)!==sourceTarget||
      await chatTabTargetSha256(destinationPage)!==destinationTarget)
      return false;
  }catch{return false;}
  if(!await retireSupersededRelayTab(sourcePage,destinationPage,sourceUrl))return false;
  try{
    assertOnlySourceRetired(before,await targetInventory(destinationPage),sourceTarget,destinationTarget);
    store.recordOwnedChatTabRetired(missionId,sourceUrl,destinationUrl);
    return true;
  }catch{
    console.error('Relay tab closed, but its physical retirement could not be confirmed');
    return false;
  }
}
