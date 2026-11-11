import type {Store} from './store.js';
import {normalizeChatGPTUrl} from './chatgpt-handoff.js';

/** A browser launch configuration is not a Mission or business Goal.
 * New tasks always get their own Chat; the source conversation is never sent. */
export function telegramChatAnchor(store:Store):{url:string;browserId:string}|null {
  const url=store.getMeta('telegram.chatgpt.anchorUrl');
  const browserId=store.getMeta('telegram.chatgpt.browserId');
  if(!url||!browserId)return null;
  if(browserId.length>200||!/^[\w.:/-]+$/.test(browserId))
    throw new Error('Configured Chrome profile identity is invalid');
  return {url:normalizeChatGPTUrl(url),browserId};
}

export function setTelegramChatAnchor(store:Store,url:string,browserId:string):void {
  const normalized=normalizeChatGPTUrl(url);
  if(!browserId||browserId.length>200||!/^[\w.:/-]+$/.test(browserId))
    throw new Error('A specific approved Chrome browser identity is required');
  store.atomic(()=>{
    store.setMeta('telegram.chatgpt.anchorUrl',normalized);
    store.setMeta('telegram.chatgpt.browserId',browserId);
  });
}
