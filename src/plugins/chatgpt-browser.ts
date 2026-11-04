import type { Page, PlaywriterBrowserConnection } from 'playwriter';
import { normalizeChatGPTUrl } from '../core/chatgpt-handoff.js';

const ASSISTANT_SELECTOR='[data-message-author-role="assistant"]';
const USER_SELECTOR='[data-message-author-role="user"]';
const COMPOSER_SELECTOR='#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"]';
const SEND_SELECTOR='button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]';
const STOP_SELECTOR='button[data-testid="stop-button"], button[aria-label="Stop generating"]';

/** ChatGPT UI has multiple DOM variants: legacy message attributes and accessible turn headings. */
function assistantHeadings(page:Page) { return page.getByRole('heading',{name:'ChatGPT said:',exact:true}); }
function userHeadings(page:Page) { return page.getByRole('heading',{name:'You said:',exact:true}); }
async function composerLocator(page:Page) {
  const legacy=page.locator(COMPOSER_SELECTOR);
  if(await legacy.count()===1) return legacy;
  return page.getByRole('textbox',{name:'Ask ChatGPT',exact:true});
}
async function sendLocator(page:Page) {
  const legacy=page.locator(SEND_SELECTOR);
  if(await legacy.count()) return legacy.first();
  return page.getByRole('button',{name:/^Send(?: prompt| message)?$/i}).first();
}

/** ChatGPT can virtualize older turns while a response is generated, so the
 * number of rendered message headings is not a monotonically increasing ID.
 * Correlate the newest visible user turn with the prompt actually submitted. */
export async function lastVisibleUserContainsPrompt(page:Page,prompt:string):Promise<boolean> {
  const legacy=page.locator(USER_SELECTOR);
  if(await legacy.count()) return (await legacy.last().innerText({timeout:5000})).includes(prompt);
  const headings=userHeadings(page);
  if(!await headings.count()) return false;
  return (await headings.last().locator('xpath=..').innerText({timeout:5000})).includes(prompt);
}

export interface ChatPageSnapshot {
  url:string;
  assistantCount:number;
  userCount:number;
  composerReady:boolean;
  generating:boolean;
  lastAssistant:string;
}
export interface BrowserReceipt extends ChatPageSnapshot {
  submitted:boolean;
  observedAt:string;
}
export interface BrowserSession {
  page:Page;
  close():Promise<void>;
}

/** Cleanup is best-effort: an interrupted relay must not replace the more useful
 * dispatch error (and its durable NEEDS_RECONCILIATION state) with `fetch failed`. */
async function closeWithoutMaskingFailure(close:()=>Promise<void>):Promise<void> {
  try {await close();}
  catch {console.error('Playwriter session cleanup warning: relay connection already unavailable');}
}

export async function withBrowserSession<T>(session:BrowserSession,work:(page:Page)=>Promise<T>):Promise<T> {
  try {return await work(session.page);}
  finally {await closeWithoutMaskingFailure(()=>session.close());}
}

/** Exact tab match only; no navigation, new tabs, arbitrary JS execution or cookie access. */
export async function connectChatPage(targetUrl:string, options:{browserId?:string;port?:number}={}):Promise<BrowserSession> {
  const target=normalizeChatGPTUrl(targetUrl);
  // Disable Playwriter's about:blank auto-attachment for this process.
  process.env.PLAYWRITER_AUTO_ENABLE='false';
  process.env.PLAYWRITER_TELEMETRY ??='0';
  let connection:PlaywriterBrowserConnection;
  try {
    const {connectViaExtension}=await import('playwriter');
    connection=await connectViaExtension({
      closeTabsOnEnd:false,tabGroup:'mission-relay',
      ...(options.port?{port:options.port}:{}),
      ...(options.browserId?{selectBrowser:browsers=>browsers.find(b=>b.id===options.browserId)}:{}),
    });
  } catch(error) {
    const reason=error instanceof Error?error.message:'unknown error';
    throw new Error(`Playwriter extension connection failed: ${reason.slice(0,400)}`);
  }
  const matches=connection.browser.contexts().flatMap(context=>context.pages())
    .filter(page=>!page.isClosed()&&page.url().replace(/\/$/,'')===target);
  if(matches.length!==1) {
    await closeWithoutMaskingFailure(()=>connection.close());
    throw new Error(`Expected exactly one Playwriter-enabled tab at the specified ChatGPT URL; found ${matches.length}. Enable the extension on the target tab, not other tabs.`);
  }
  return {page:matches[0]!,close:()=>connection.close()};
}

export async function inspectChatPage(page:Page,expectedUrl:string):Promise<ChatPageSnapshot> {
  const target=normalizeChatGPTUrl(expectedUrl);
  const current=page.url().replace(/\/$/,'');
  if(current!==target) throw new Error('ChatGPT tab navigated away from the authorized conversation');
  const assistant=page.locator(ASSISTANT_SELECTOR);
  const legacyCount=await assistant.count();
  const count=legacyCount||await assistantHeadings(page).count();
  const legacyUserCount=await page.locator(USER_SELECTOR).count();
  const userCount=legacyUserCount||await userHeadings(page).count();
  const composer=await composerLocator(page);
  const composerReady=(await composer.count())===1 && await composer.isVisible();
  const legacyStop=page.locator(STOP_SELECTOR);
  const accessibleStop=page.getByRole('button',{name:/^Stop (?:generating|response)$/i});
  const generating=(await legacyStop.count()>0 && await legacyStop.first().isVisible()) ||
    (await accessibleStop.count()>0 && await accessibleStop.first().isVisible());
  const lastAssistant=count?legacyCount
    ? await assistant.last().innerText({timeout:5000})
    : (await assistantHeadings(page).last().locator('xpath=..').innerText({timeout:5000}))
      .replace(/^ChatGPT said:\s*/,'')
    :'';
  // Preserve the complete visible answer internally so the observed SHA-256
  // covers the actual response, not just its last 4,000 characters. Caller
  // controls external disclosure (CLI probe and SQLite summaries stay brief).
  return {url:current,assistantCount:count,userCount,composerReady,generating,lastAssistant};
}

function delay(ms:number):Promise<void> {return new Promise(resolve=>setTimeout(resolve,ms));}

export const DEFAULT_BROWSER_TURN_TIMEOUT_MS=35*60*1000;
export const MAX_BROWSER_TURN_TIMEOUT_MS=45*60*1000;

/** A 5–30-minute model turn only needs one DOM snapshot per minute. The one
 * exception is a response with an apparent final marker: confirm its stable
 * text on a second read after three seconds before committing a receipt. */
export const ACTIVE_REPLY_OBSERVATION_INTERVAL_MS=60_000;
export function observationDelayMs(_elapsedMs:number,finalCandidate:boolean):number {
  return finalCandidate?3_000:ACTIVE_REPLY_OBSERVATION_INTERVAL_MS;
}

/** A newly opened tab has a separate short Chrome/SPA bootstrap phase before
 * the stable direct ChatGPT conversation URL exists. This is not a model poll. */
export function newChatBootstrapDelayMs(elapsedMs:number,settling:boolean,
  finalCandidate:boolean):number {
  if(finalCandidate)return observationDelayMs(elapsedMs,true);
  if(settling && elapsedMs<20_000)return 2_000;
  return observationDelayMs(elapsedMs,false);
}

/** During the first Send on a fresh tab, ChatGPT may briefly use same-origin
 * transitional URLs (including query parameters) before its permanent /c/ URL
 * is available. Never accept another origin or an unrelated path. */
export function isPendingNewChatUrl(value:string):boolean {
  try {
    const u=new URL(value);
    return u.origin==='https://chatgpt.com'&&!u.username&&!u.password&&!u.hash&&
      (u.pathname==='/'||/^\/c\/[A-Za-z0-9-]{20,}\/?$/.test(u.pathname));
  }catch{return false;}
}

/** A just-submitted new chat may temporarily expose about:blank, a Chrome
 * transition page, or a same-origin noncanonical path. Do not inspect or send
 * to those pages. Allow only a short read-only URL-settle interval, then fail
 * closed if the exact direct ChatGPT conversation URL never appears. */
export function tolerateRolloverNavigation(value:string,elapsedMs:number):boolean {
  if(!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>=20000)return false;
  if(value===''||value==='data:,'||value==='data:text/html,')return true;
  if(isPendingNewChatUrl(value))return true;
  try {
    const url=new URL(value);
    return url.protocol==='about:'||url.protocol==='chrome:'||
      url.protocol==='chrome-error:'||url.protocol==='chrome-extension:'||
      (url.origin==='https://chatgpt.com'&&!url.username&&!url.password);
  } catch {return false;}
}

/** Coarse diagnostics only: do not write the full address, account ID or
 * extension URL to SQLite, Telegram or public logs. */
export function rolloverUrlClass(value:string):string {
  if(!value)return 'empty';
  try {
    const url=new URL(value);
    if(url.origin==='https://chatgpt.com')return 'chatgpt-transitional';
    if(['about:','chrome:','chrome-error:','chrome-extension:','data:'].includes(url.protocol))
      return 'browser-internal';
    return 'other-origin';
  }catch{return 'invalid';}
}

/** Only one same-URL page refresh may be performed, never a second Send.
 * The full direct URL must be known and no generation visible. */
export function shouldReloadBlankNewChat(elapsedMs:number,
  snapshot:ChatPageSnapshot,alreadyReloaded:boolean):boolean {
  return !alreadyReloaded && elapsedMs>=120_000 && !snapshot.generating &&
    !snapshot.lastAssistant.trim();
}

/** Refresh is a read-only recovery of an already submitted *new* chat, never
 * a Send or a navigation to an unverified URL. */
export async function reloadBlankDirectNewChat(page:Page,expectedUrl:string):Promise<void> {
  const exact=normalizeChatGPTUrl(expectedUrl);
  if(normalizeChatGPTUrl(page.url())!==exact)
    throw new Error('New-chat refresh refused: browser no longer at the expected direct conversation');
  await page.reload({waitUntil:'domcontentloaded',timeout:30000});
}

function visibleChatResponseFailed(answer:string):boolean {
  return /(?:This response couldn.t load|Unable to load response|Something went wrong while generating)/i.test(answer);
}

/** Never retry the send click after an ambiguous exception. Caller owns durable reservation. */
export async function submitChatTurn(page:Page,targetUrl:string,prompt:string,
  timeoutMs=DEFAULT_BROWSER_TURN_TIMEOUT_MS,requireFinalMarker=false):Promise<BrowserReceipt> {
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)
    throw new Error('Prompt must contain 1–12000 characters');
  if(!Number.isInteger(timeoutMs)||timeoutMs<10000||timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS)
    throw new Error('Browser turn timeout must be between 10 seconds and 45 minutes');
  // Mission continuation turns explicitly require a final marker. The accessible
  // ChatGPT UI may not expose a Stop button while streaming; a short stable
  // pause alone is not evidence that the response is finished.
  const finalMarker=/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/;
  const before=await inspectChatPage(page,targetUrl);
  if(!before.composerReady||before.generating)
    throw new Error('ChatGPT composer not ready or another response is generating');
  const composer=await composerLocator(page);
  await composer.fill(prompt.trim(),{timeout:10000});
  const send=await sendLocator(page);
  if(await send.count()<1) throw new Error('ChatGPT Send button was not found; UI selector review required');
  if(!await send.isEnabled()) throw new Error('ChatGPT Send button is not enabled');
  await send.click({timeout:10000});
  // Sending may have succeeded even if the next read fails. Never click twice.
  const startedAt=Date.now(),deadline=startedAt+timeoutMs;
  let last='';let stableSince=Date.now();
  let failureSince:number|null=null;
  while(Date.now()<deadline) {
    const current=await inspectChatPage(page,targetUrl);
    if(!current.generating&&visibleChatResponseFailed(current.lastAssistant)) {
      failureSince??=Date.now();
      if(Date.now()-failureSince>=5000)
        throw new Error('ChatGPT displayed a response-load failure; submission outcome is ambiguous');
    }else failureSince=null;
    let finalCandidate=false;
    if(current.userCount>0 && current.assistantCount>0 && current.lastAssistant &&
       current.lastAssistant!==before.lastAssistant &&
       await lastVisibleUserContainsPrompt(page,prompt.trim())) {
      if(current.lastAssistant!==last){last=current.lastAssistant;stableSince=Date.now();}
      finalCandidate=!current.generating && (!requireFinalMarker||finalMarker.test(current.lastAssistant.trim()));
      if(finalCandidate && Date.now()-stableSince>=2500) {
        return {...current,submitted:true,observedAt:new Date().toISOString()};
      }
    }
    // A visible reply-load error is checked once more after five seconds; it
    // must not be hidden until the next normal 60-second model poll.
    const retryDelay=failureSince===null?Infinity:Math.max(0,5_000-(Date.now()-failureSince));
    await delay(Math.max(0,Math.min(observationDelayMs(Date.now()-startedAt,finalCandidate),
      retryDelay,deadline-Date.now())));
  }
  throw new Error('ChatGPT response observation timed out; submission outcome is ambiguous');
}

/** Create a real ChatGPT conversation in an already authorized *new* tab.
 * The page starts at https://chatgpt.com/ and may acquire its exact /c/ URL
 * only after the first Send click; never infer or fabricate that destination. */
export async function submitNewChatTurn(page:Page,prompt:string,
  timeoutMs=DEFAULT_BROWSER_TURN_TIMEOUT_MS):Promise<{url:string;receipt:BrowserReceipt}> {
  if(!prompt.trim()||prompt.length>12000)throw new Error('Invalid new-chat handoff prompt');
  if(!Number.isInteger(timeoutMs)||timeoutMs<10000||timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS)
    throw new Error('Invalid new-chat timeout');
  await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:30000});
  // A fast CDP-driven click can race hydration on the first fresh SPA load.
  // Waiting for the document load event is a small one-time bootstrap cost.
  await page.waitForLoadState('load',{timeout:30000});
  const startingUrl=page.url();
  if(startingUrl!=='https://chatgpt.com/'&&startingUrl!=='https://chatgpt.com')
    throw new Error('New ChatGPT tab did not open the authorized origin');
  const composer=await composerLocator(page);
  await composer.fill(prompt.trim(),{timeout:10000});
  const send=await sendLocator(page);
  if(!await send.count()||!await send.isEnabled())
    throw new Error('New ChatGPT tab has no enabled Send button');
  await send.click({timeout:10000});
  const start=Date.now(),deadline=start+timeoutMs;
  const finalMarker=/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED)\]\s*$/;
  let last='',stableSince=start,failureSince:number|null=null,reloadedBlank=false;
  while(Date.now()<deadline) {
    const currentUrl=page.url();
    let destination:string|null=null;
    try{destination=normalizeChatGPTUrl(currentUrl);}catch{
      if(!tolerateRolloverNavigation(currentUrl,Date.now()-start))
        throw new Error(`New ChatGPT tab navigated outside an authorized direct conversation URL (class=${rolloverUrlClass(currentUrl)})`);
    }
    let finalCandidate=false;
    if(destination) {
      const snapshot=await inspectChatPage(page,destination);
      if(shouldReloadBlankNewChat(Date.now()-start,snapshot,reloadedBlank)) {
        reloadedBlank=true;
        // Reload only the already-known exact conversation, never the old tab
        // or an uncertain noncanonical origin; do not click Send again.
        console.warn('New ChatGPT conversation has no visible answer after two minutes; refreshing the same authorized tab once without resending');
        await reloadBlankDirectNewChat(page,destination);
        continue;
      }
      if(!snapshot.generating&&visibleChatResponseFailed(snapshot.lastAssistant)) {
        failureSince??=Date.now();
        if(Date.now()-failureSince>=5000)
          throw new Error('New ChatGPT reply failed to load; first Send may have committed; do not replay');
      }else failureSince=null;
      if(snapshot.userCount>0 && snapshot.assistantCount>0 && snapshot.lastAssistant &&
        await lastVisibleUserContainsPrompt(page,prompt.trim())) {
        if(snapshot.lastAssistant!==last){last=snapshot.lastAssistant;stableSince=Date.now();}
        finalCandidate=!snapshot.generating && finalMarker.test(snapshot.lastAssistant.trim());
        if(finalCandidate && Date.now()-stableSince>=2500)
          return {url:destination,receipt:{...snapshot,submitted:true,observedAt:new Date().toISOString()}};
      }
    }
    const retryDelay=failureSince===null?Infinity:Math.max(0,5_000-(Date.now()-failureSince));
    await delay(Math.max(0,Math.min(newChatBootstrapDelayMs(Date.now()-start,
      !destination,finalCandidate),retryDelay,deadline-Date.now())));
  }
  throw new Error('New ChatGPT reply observation timed out; creation outcome is ambiguous');
}
