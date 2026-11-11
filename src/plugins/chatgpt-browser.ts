import type { Page, PlaywriterBrowserConnection } from 'playwriter';
import {createHash} from 'node:crypto';
import { normalizeChatGPTUrl } from '../core/chatgpt-handoff.js';

const ASSISTANT_SELECTOR='[data-message-author-role="assistant"]';
const USER_SELECTOR='[data-message-author-role="user"]';
const COMPOSER_SELECTOR='#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"]';
const SEND_SELECTOR='button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]';
const STOP_SELECTOR='button[data-testid="stop-button"], button[aria-label="Stop generating"]';
const RELAY_END_MARKER=/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/;

/** ChatGPT may render generated file cards AFTER the final assistant marker.
 * They are browser UI, not additional assistant prose. Only remove them if
 * their exact visible text accounts for the entire suffix and one rendered
 * prose block itself ends with the required marker. Never strip arbitrary
 * trailing text or treat a marker in the middle of an answer as terminal. */
export function stripVerifiedFileCardTail(
  fullAnswer:string,renderedProse:string,resourceCards:string[],
):string {
  if(!resourceCards.length||!RELAY_END_MARKER.test(renderedProse.trim()))return fullAnswer;
  const at=fullAnswer.indexOf(renderedProse);
  if(at<0||fullAnswer.slice(0,at).trim())return fullAnswer;
  const suffix=fullAnswer.slice(at+renderedProse.length).trim();
  const cards=resourceCards.map(text=>text.trim()).join('\n');
  return suffix&&suffix===cards?renderedProse:fullAnswer;
}

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

/** Accessible ChatGPT transcript wrappers can put You said: and Show more
 * controls into the parent heading's innerText. They are NOT user-authored
 * prompt bytes. Strip only these exact observed UI decorations; other text
 * differences must remain a hash mismatch and fail closed. */
export function canonicalVisibleUserPrompt(text:string,headingWrapper:boolean):string {
  const withoutHeader=headingWrapper?text.replace(/^You said:\s*/,''):text;
  return withoutHeader
    .replace(/\n(?:…|\.\.\.)\s*\nShow more\s*$/u,'')
    // Expanded long prompts expose a Show less control inside the same
    // heading wrapper. It is UI chrome, not another user-authored sentence.
    .replace(/\nShow less\s*$/u,'').trim();
}

/** User-authored last visible prompt, excluding ChatGPT accessibility labels.
 * An adoption goal can be seeded from it without inventing a new task. */
export async function lastVisibleUserPrompt(page:Page):Promise<string|null>{
  const legacy=page.locator(USER_SELECTOR);
  if(await legacy.count())return canonicalVisibleUserPrompt(
    await legacy.last().innerText({timeout:5000}),false);
  const headings=userHeadings(page);
  if(!await headings.count())return null;
  return canonicalVisibleUserPrompt(
    await headings.last().locator('xpath=..').innerText({timeout:5000}),true);
}

/** Read-only recovery guard: match the last submitted prompt hash, never
 * assume that an unchanged assistant message means no human intervened. */
export async function lastVisibleUserPromptSha256(page:Page):Promise<string|null> {
  const last=await lastVisibleUserPrompt(page);
  return last===null?null:createHash('sha256').update(last).digest('hex');
}

/** A read-only Chrome Target fingerprint for EXACT physical tab custody.
 * A ChatGPT URL is not a tab identity: an owner can reopen the same URL in a
 * different tab. Pinned Playwriter 0.9 exposes the physical Chrome target on
 * its Page as _targetId; this was independently observed stable across two
 * GMK extension connections, unlike the transient Playwright _guid. Use a
 * public page-scoped CDP read only if that local Playwriter implementation
 * supports it. The private field is not assumed to exist in future versions.
 * Never persist or expose raw target IDs; on unsupported/changed sessions
 * return null so cross-Mission cleanup fails closed. Same-loop object-owned
 * cleanup does not depend on this optional extension capability. */
export async function chatTabTargetSha256(page:Page):Promise<string|null>{
  const valid=(id:unknown):id is string=>
    typeof id==='string'&&/^[A-Za-z0-9_.:-]{8,256}$/.test(id);
  // No CDP debugger reattachment is needed for normal Playwriter 0.9 pages.
  // This internal read is a pinned-version integration, not a general API.
  const direct=(page as Page&{_targetId?:unknown})._targetId;
  if(valid(direct))return createHash('sha256').update(direct).digest('hex');
  let session:Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>|null=null;
  try{
    session=await page.context().newCDPSession(page);
    const result=await session.send('Target.getTargetInfo') as
      {targetInfo?:{targetId?:unknown}};
    const id=result?.targetInfo?.targetId;
    return valid(id)
      ?createHash('sha256').update(id).digest('hex'):null;
  }catch{
    return null;
  }finally{
    if(session)try{await session.detach();}catch{/* read-only diagnostic unavailable */ }
  }
}

/** Exact correlation for a pending Send. A later PI/owner prompt may quote
 * the complete earlier prompt; substring containment would misattribute the
 * later assistant answer to the earlier Send. */
export function matchesSubmittedUserPrompt(lastVisibleSha256:string|null,prompt:string):boolean {
  return lastVisibleSha256!==null &&
    lastVisibleSha256===createHash('sha256').update(prompt.trim()).digest('hex');
}

/** Recovery uses the original SQLite reservation hash. PI may have authored a
 * prompt that cannot be rebuilt from the Mission goal after an interruption. */
export function matchesReservedPromptHash(lastVisibleSha256:string|null,reservedSha256:string):boolean {
  return lastVisibleSha256!==null && lastVisibleSha256===reservedSha256;
}

export interface ChatPageSnapshot {
  url:string;
  assistantCount:number;
  userCount:number;
  composerReady:boolean;
  generating:boolean;
  lastAssistant:string;
  /** Visible turn identity, not the answer hash. A later turn can repeat text. */
  lastAssistantTurnId?:string|null;
}
export interface BrowserReceipt extends ChatPageSnapshot {
  submitted:boolean;
  observedAt:string;
}
export interface BrowserSession {
  page:Page;
  close():Promise<void>;
}

/** Read-only inventory of Playwriter-enabled ChatGPT tabs in ONE pinned
 * Chrome profile. Tab groups do not restrict this inventory. An unenabled
 * Chrome tab is NOT exposed by the public Playwriter extension API. */
export async function listConnectedChatCandidates(browserId:string,
  onlyReadUserPromptForUrl?:string):Promise<Array<{
  url:string;urlSha256:string;duplicate:boolean;lastUserSha256:string|null
}>> {
  if(!/^[A-Za-z0-9:._-]{1,200}$/.test(browserId))
    throw new Error('A pinned Chrome browser ID is required');
  const selectedUrl=onlyReadUserPromptForUrl?
    normalizeChatGPTUrl(onlyReadUserPromptForUrl):null;
  process.env.PLAYWRITER_AUTO_ENABLE='false';
  process.env.PLAYWRITER_TELEMETRY ??='0';
  const {connectViaExtension}=await import('playwriter');
  const connection=await connectViaExtension({closeTabsOnEnd:false,tabGroup:'mission-relay',
    selectBrowser:browsers=>browsers.find(browser=>browser.id===browserId)});
  try {
    const pages=connection.browser.contexts().flatMap(context=>context.pages())
      .filter(page=>!page.isClosed())
      .flatMap(page=>{try{return [{page,url:normalizeChatGPTUrl(page.url())}];}catch{return [];}});
    const result:Array<{url:string;urlSha256:string;duplicate:boolean;lastUserSha256:string|null}>=[];
    for(const {page,url} of pages) {
      // One malformed/changed page cannot prevent discovery of other tabs.
      let lastUserSha256:string|null=null;
      // Exact-binding diagnostics have no reason to inspect user messages
      // in OTHER enabled chats. Existing owner-approved watch discovery still
      // uses the original all-candidates behavior without this filter.
      try {if(!selectedUrl||selectedUrl===url)
        lastUserSha256=await lastVisibleUserPromptSha256(page);}
      catch {/* A loading, inaccessible or unsupported DOM is not adoptable. */}
      result.push({url,urlSha256:createHash('sha256').update(url).digest('hex'),
        duplicate:pages.filter(item=>item.url===url).length!==1,lastUserSha256});
    }
    return result;
  }finally{await closeWithoutMaskingFailure(()=>connection.close());}
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
/** Open an owned Playwriter-enabled bootstrap tab in the SAME approved Chrome
 * profile. This source is used solely to open a DIFFERENT new ChatGPT chat;
 * no user message is sent to the old conversation. Only new owner-authenticated
 * Telegram tasks may opt into this fallback, never recovery or continuation. */
export async function bootstrapMissingChatAnchor(context:{newPage():Promise<Page>},target:string):Promise<Page> {
  const page=await context.newPage();
  try{
    await page.goto(target,{waitUntil:'domcontentloaded',timeout:30000});
    const state=await inspectChatPage(page,target);
    if(!state.composerReady||state.generating)
      throw new Error('Automatically opened ChatGPT source is not idle or authenticated');
    return page;
  }catch(error){
    await page.close().catch(()=>{});
    throw error;
  }
}

export async function connectChatPage(targetUrl:string, options:{browserId?:string;port?:number;bootstrapMissingAnchor?:boolean}={}):Promise<BrowserSession> {
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
  if(matches.length===0&&options.bootstrapMissingAnchor&&options.browserId){
    let bootstrap:Page;
    try {
      const context=connection.browser.contexts()[0];
      if(!context)throw new Error('Pinned Chrome profile has no browser context');
      bootstrap=await bootstrapMissingChatAnchor(context,target);
    }catch(error){
      await closeWithoutMaskingFailure(()=>connection.close());
      const reason=error instanceof Error?error.message:'unknown error';
      throw new Error(`Cannot automatically bootstrap a fresh ChatGPT task in the approved Chrome profile: ${reason.slice(0,350)}`);
    }
    return {page:bootstrap,close:async()=>{
      // Only this owned source page is disposable. The actual new conversation
      // was created separately by executeBrowserRollover and must survive.
      await bootstrap.close().catch(()=>{});
      await connection.close();
    }};
  }
  if(matches.length!==1) {
    await closeWithoutMaskingFailure(()=>connection.close());
    throw new Error(`Expected exactly one Playwriter-enabled tab at the specified ChatGPT URL; found ${matches.length}. New owner tasks can bootstrap an authorized tab; recovery and existing-chat continuation require the exact tab.`);
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
  // ChatGPT's newer composer renders a bare aria-label="Stop" while the
  // answer is still streaming (verified on a live Work conversation). Scope
  // it to the composer form so unrelated Stop controls do not block progress.
  const composerStop=page.locator('form button[aria-label="Stop"]');
  const generating=(await legacyStop.count()>0 && await legacyStop.first().isVisible()) ||
    (await accessibleStop.count()>0 && await accessibleStop.first().isVisible()) ||
    (await composerStop.count()>0 && await composerStop.first().isVisible());
  let lastAssistant=count?legacyCount
    ? await assistant.last().innerText({timeout:5000})
    : (await assistantHeadings(page).last().locator('xpath=..').innerText({timeout:5000}))
      .replace(/^ChatGPT said:\s*/,'')
    :'';
  // ChatGPT can produce identical text in consecutive assistant turns. The
  // accessible transcript exposes an identity for each message; do not use
  // a count increase alone, because virtualization can change DOM counts.
  const turn=legacyCount?assistant.last():count?
    assistantHeadings(page).last().locator('xpath=..'):null;
  if(turn&&lastAssistant.includes('[MISSION_RELAY:')&&
     !RELAY_END_MARKER.test(lastAssistant.trim())) {
    // Playwriter's selector bridge can strip quotes from CSS attribute-word
    // selectors and produce invalid CSS for Tailwind class tokens containing
    // '/'. XPath matches the exact whitespace-delimited class without that
    // transport-dependent selector rewrite (verified against real Chrome).
    const resourceRows=turn.locator(
      'xpath=.//*[contains(concat(" ",normalize-space(@class)," ")," group/resource-row ")]');
    const rowCount=await resourceRows.count();
    if(rowCount>0&&rowCount<=12) {
      const prose=turn.locator('[class*="MarkdownRoot-"]');
      if(await prose.count()===1) {
        const cards:string[]=[];
        for(let i=0;i<rowCount;i++)cards.push(await resourceRows.nth(i).innerText({timeout:5000}));
        lastAssistant=stripVerifiedFileCardTail(lastAssistant,
          await prose.innerText({timeout:5000}),cards);
      }
    }
  }
  let lastAssistantTurnId:string|null=null;
  if(turn && typeof turn.getAttribute==='function') {
    try {
      lastAssistantTurnId=await turn.getAttribute('data-content-search-unit-key')||
        await turn.getAttribute('data-message-id')||
        await turn.getAttribute('data-turn-id');
    }catch {/* Unsupported or changing DOM: stay conservative. */}
  }
  // Preserve the complete visible answer internally so the observed SHA-256
  // covers the actual response, not just its last 4,000 characters. Caller
  // controls external disclosure (CLI probe and SQLite summaries stay brief).
  return {url:current,assistantCount:count,userCount,composerReady,generating,
    lastAssistant,lastAssistantTurnId};
}

/** A genuine new assistant message need not have different words. Never use
 * DOM count alone as a substitute for a stable, changed message identity. */
export function isNewAssistantReply(before:ChatPageSnapshot,
  current:ChatPageSnapshot):boolean {
  return Boolean(current.lastAssistant) && (
    current.lastAssistant!==before.lastAssistant ||
    Boolean(before.lastAssistantTurnId&&current.lastAssistantTurnId&&
      before.lastAssistantTurnId!==current.lastAssistantTurnId));
}

/** A provisional DOM snapshot can lose the old assistant while ChatGPT
 * re-renders a newly submitted user turn. A changed/blank `before` then makes
 * the *old* answer look new. The durable prior-answer digest is the authority:
 * never credit those same bytes unless a distinct, stable message identity
 * establishes that a genuinely new assistant turn repeated the same answer.
 * Synthetic `fallback-turn-*` identities are not sufficient for that proof. */
export function isNewReplyAgainstVerifiedSource(before:ChatPageSnapshot,
  current:ChatPageSnapshot,source?:{assistantSha256:string;assistantTurnId:string|null}):boolean {
  if(!isNewAssistantReply(before,current))return false;
  if(!source || createHash('sha256').update(current.lastAssistant).digest('hex')!==
    source.assistantSha256)return true;
  const oldId=source.assistantTurnId,newId=current.lastAssistantTurnId;
  return Boolean(oldId&&newId&&oldId!==newId &&
    !oldId.startsWith('fallback-turn-')&&!newId.startsWith('fallback-turn-'));
}

function delay(ms:number):Promise<void> {return new Promise(resolve=>setTimeout(resolve,ms));}

export const DEFAULT_BROWSER_TURN_TIMEOUT_MS=60*60*1000;
export const MAX_BROWSER_TURN_TIMEOUT_MS=4*60*60*1000;

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

/** A brief inaccessible answer node is not evidence that the already-sent
 * message failed. Retry DOM READS only; never repeat the composer Send. Other
 * failures (URL change, lost browser or unknown selector) still fail closed. */
function isTransientAssistantReadTimeout(error:unknown):boolean {
  return error instanceof Error &&
    /^locator\.innerText:\s*Timeout \d+ms exceeded\./i.test(error.message);
}
async function inspectAfterSend(page:Page,url:string,
  state:{consecutiveReadFailures:number},deadline:number):Promise<ChatPageSnapshot|null> {
  try {
    const snapshot=await inspectChatPage(page,url);
    state.consecutiveReadFailures=0;
    return snapshot;
  }catch(error){
    if(!isTransientAssistantReadTimeout(error)||++state.consecutiveReadFailures>=3)
      throw error;
    await delay(Math.max(0,Math.min(2000,deadline-Date.now())));
    return null;
  }
}

/** Transient ChatGPT transport banners must not be credited as final answers.
 * The banner is checked explicitly; never treat a generic Retry as authorization. */
export const CONNECTION_INTERRUPTED_TEXT='Connection interrupted. Waiting for the complete answer';
export const MESSAGE_DELIVERY_TIMEOUT_TEXT='Message delivery timed out. Please try again.';
export const INTERRUPTED_WAIT_GRACE_MS=120*60_000;
export const MAX_INTERRUPTED_WAIT_MS=4*60*60_000;

export async function visibleLongTaskBanner(page:Page,answer:string):Promise<'interrupted'|'delivery-timeout'|null>{
  // A model can discuss these strings in ordinary prose. Only an exact
  // trailing status line or a separately visible exact UI banner qualifies.
  const trailingLine=answer.trimEnd().split('\n').at(-1)?.trim()??'';
  const visible=async(text:string):Promise<boolean>=>{
    if(typeof page.getByText!=='function')return false;
    const found=page.getByText(text,{exact:true});
    const count=await found.count();
    for(let i=0;i<Math.min(count,4);i++){
      if(await found.nth(i).isVisible())return true;
    }
    return false;
  };
  if(trailingLine===MESSAGE_DELIVERY_TIMEOUT_TEXT||
     await visible(MESSAGE_DELIVERY_TIMEOUT_TEXT))return 'delivery-timeout';
  if(trailingLine===CONNECTION_INTERRUPTED_TEXT||
     await visible(CONNECTION_INTERRUPTED_TEXT))return 'interrupted';
  return null;
}

/** Extend a default-length interrupted run once. Explicit timeouts win. */
export function interruptedDeadline(start:number,deadline:number,now:number,
  allowExtension:boolean):number {
  return allowExtension?Math.max(deadline,
    Math.min(start+MAX_INTERRUPTED_WAIT_MS,now+INTERRUPTED_WAIT_GRACE_MS)):deadline;
}

/** Owner-approved UI Retry of the existing delivery, not a second composer Send. */
export async function clickDeliveryRetryOnce(page:Page,expectedUrl:string,
  latestUserMatchesReserved:boolean,alreadyClicked:boolean):Promise<boolean> {
  if(alreadyClicked||!latestUserMatchesReserved)return false;
  if(normalizeChatGPTUrl(page.url())!==normalizeChatGPTUrl(expectedUrl))
    throw new Error('Delivery Retry refused: conversation URL changed');
  if(await visibleLongTaskBanner(page,'')!=='delivery-timeout')return false;
  const retry=page.getByRole('button',{name:'Retry',exact:true});
  if(await retry.count()!==1||!await retry.isVisible()||!await retry.isEnabled())return false;
  await retry.click({timeout:10000});
  return true;
}

/** A pre-existing ChatGPT reply-load error belongs to the *previous* turn.
 * It must not mark the newly submitted request uncertain while ChatGPT is
 * still rendering its next assistant message. DOM counts can be virtualized,
 * so an unchanged previous error is never evidence of a new failed reply. */
export function isFreshResponseLoadFailure(before:ChatPageSnapshot,
  current:ChatPageSnapshot,newestUserMatchesPrompt:boolean):boolean {
  return newestUserMatchesPrompt&&!current.generating&&
    visibleChatResponseFailed(current.lastAssistant)&&
    isNewAssistantReply(before,current)&&
    (!visibleChatResponseFailed(before.lastAssistant)||
      current.assistantCount>before.assistantCount);
}

/** Never retry the send click after an ambiguous exception. Caller owns durable reservation. */
export async function submitChatTurn(page:Page,targetUrl:string,prompt:string,
  timeoutMs=DEFAULT_BROWSER_TURN_TIMEOUT_MS,requireFinalMarker=false,
  verifiedSource?:{assistantSha256:string;assistantTurnId:string|null}):Promise<BrowserReceipt> {
  if(typeof prompt!=='string'||!prompt.trim()||prompt.length>12000)
    throw new Error('Prompt must contain 1–12000 characters');
  if(!Number.isInteger(timeoutMs)||timeoutMs<10000||timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS)
    throw new Error('Browser turn timeout must be between 10 seconds and 4 hours');
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
  const startedAt=Date.now();let deadline=startedAt+timeoutMs;
  let last='',lastTurnId:string|null=null;let stableSince=Date.now();
  let failureSince:number|null=null;
  let interruptedSeen=false,deliveryRetryClicked=false,transportExtensionUsed=false;
  const readState={consecutiveReadFailures:0};
  while(Date.now()<deadline) {
    const current=await inspectAfterSend(page,targetUrl,readState,deadline);
    if(!current){last='';lastTurnId=null;stableSince=Date.now();continue;}
    const newestUserMatchesPrompt=current.userCount>0 &&
      matchesSubmittedUserPrompt(await lastVisibleUserPromptSha256(page),prompt);
    const banner=await visibleLongTaskBanner(page,current.lastAssistant);
    if(banner==='interrupted'&&newestUserMatchesPrompt&&!interruptedSeen) {
      interruptedSeen=true;
      if(!transportExtensionUsed){
        deadline=interruptedDeadline(startedAt,deadline,Date.now(),
          timeoutMs===DEFAULT_BROWSER_TURN_TIMEOUT_MS);
        transportExtensionUsed=true;
      }
      console.warn('ChatGPT connection interrupted; waiting for the same response without another Send');
    }
    if(banner==='delivery-timeout'&&!deliveryRetryClicked&&newestUserMatchesPrompt) {
      const clicked=await clickDeliveryRetryOnce(page,targetUrl,true,false);
      if(clicked) {
        deliveryRetryClicked=true;
        if(!transportExtensionUsed){
          deadline=interruptedDeadline(startedAt,deadline,Date.now(),
            timeoutMs===DEFAULT_BROWSER_TURN_TIMEOUT_MS);
          transportExtensionUsed=true;
        }
        console.warn('ChatGPT delivery timed out; clicked its existing-message Retry button once');
        await delay(Math.min(3000,Math.max(0,deadline-Date.now())));
        continue;
      }
    }
    if(banner===null&&isFreshResponseLoadFailure(before,current,newestUserMatchesPrompt)) {
      failureSince??=Date.now();
      if(Date.now()-failureSince>=5000)
        throw new Error('ChatGPT displayed a response-load failure; submission outcome is ambiguous');
    }else failureSince=null;
    let finalCandidate=false;
    if(current.userCount>0 && current.assistantCount>0 &&
       isNewReplyAgainstVerifiedSource(before,current,verifiedSource) &&
       newestUserMatchesPrompt) {
      if(current.lastAssistant!==last||current.lastAssistantTurnId!==lastTurnId){
        last=current.lastAssistant;
        lastTurnId=current.lastAssistantTurnId??null;
        stableSince=Date.now();
      }
      finalCandidate=!current.generating && banner===null &&
        (!requireFinalMarker||finalMarker.test(current.lastAssistant.trim()));
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

/** Read-only first-party origin load for a NEW, explicitly owned tab.
 * Caller can test hydration before consuming a one-shot pre-Send recovery
 * authorization. This does not fill the composer or click Send. */
export async function prepareNewChatOrigin(page:Page):Promise<void>{
  await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForLoadState('load',{timeout:30000});
  const url=page.url();
  if(url!=='https://chatgpt.com/'&&url!=='https://chatgpt.com')
    throw new Error('New ChatGPT tab did not open the authorized origin');
  if(await userHeadings(page).count()||await page.locator(USER_SELECTOR).count())
    throw new Error('Prepared new ChatGPT origin already contains a user message');
  const composer=await composerLocator(page);
  if(await composer.count()!==1||!await composer.isVisible())
    throw new Error('New ChatGPT origin has no visible, unique authenticated composer');
}

/** A hydrated origin may expose a composer before its Send control is ready.
 * Only WAIT and reread the same owned, empty origin: never fill twice, press
 * Enter, or click a different control. If a user turn appears or navigation
 * starts without our click, treat it as ambiguous and refuse another Send. */
export async function waitForNewChatSendReady(page:Page,
  maxWaitMs=8_000):Promise<void>{
  if(!Number.isInteger(maxWaitMs)||maxWaitMs<0||maxWaitMs>10_000)
    throw new Error('Invalid new-chat Send hydration wait');
  const deadline=Date.now()+maxWaitMs;
  for(;;){
    if(!['https://chatgpt.com/','https://chatgpt.com'].includes(page.url()))
      throw new Error('New ChatGPT origin navigated before clicking Send; outcome ambiguous');
    if(await userHeadings(page).count()||await page.locator(USER_SELECTOR).count())
      throw new Error('New ChatGPT origin already shows a submitted user message; no second Send');
    const send=await sendLocator(page);
    if(await send.count()&&await send.isVisible()&&await send.isEnabled())return;
    if(Date.now()>=deadline)
      throw new Error('New ChatGPT tab has no enabled Send button after bounded hydration');
    await delay(Math.min(400,deadline-Date.now()));
  }
}

/** Create one real ChatGPT conversation in an already authorized new tab.
 * A preparedOrigin may only be supplied by a caller that just ran the
 * read-only origin preflight; no second navigation or Send is implied. */
export async function submitNewChatTurn(page:Page,prompt:string,
  timeoutMs=DEFAULT_BROWSER_TURN_TIMEOUT_MS,
  preparedOrigin=false):Promise<{url:string;receipt:BrowserReceipt}> {
  if(!prompt.trim()||prompt.length>12000)throw new Error('Invalid new-chat handoff prompt');
  if(!Number.isInteger(timeoutMs)||timeoutMs<10000||timeoutMs>MAX_BROWSER_TURN_TIMEOUT_MS)
    throw new Error('Invalid new-chat timeout');
  if(!preparedOrigin){
    // Preserve the established production new-chat path for all ordinary
    // Relay Sends. The extra hydration preflight is only for explicitly
    // authorized one-shot recovery of a proven old pre-Send failure.
    await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:30000});
    await page.waitForLoadState('load',{timeout:30000});
    const startingUrl=page.url();
    if(startingUrl!=='https://chatgpt.com/'&&startingUrl!=='https://chatgpt.com')
      throw new Error('New ChatGPT tab did not open the authorized origin');
  }else{
    // The caller must have just prepared this exact owned tab. A malicious,
    // stale or navigated page may not bypass the origin/empty-chat guards.
    const startingUrl=page.url();
    if(startingUrl!=='https://chatgpt.com/'&&startingUrl!=='https://chatgpt.com')
      throw new Error('Prepared ChatGPT tab no longer has the authorized origin');
    if(await userHeadings(page).count()||await page.locator(USER_SELECTOR).count())
      throw new Error('Prepared ChatGPT tab contains an existing user message');
  }
  const composer=await composerLocator(page);
  await composer.fill(prompt.trim(),{timeout:10000});
  await waitForNewChatSendReady(page);
  const send=await sendLocator(page);
  await send.click({timeout:10000});
  const start=Date.now();let deadline=start+timeoutMs;
  const finalMarker=/(?:^|\n)\[MISSION_RELAY:(?:NEXT|DONE|BLOCKED|HANDOFF)\]\s*$/;
  let last='',stableSince=start,failureSince:number|null=null,reloadedBlank=false;
  let interruptedSeen=false,deliveryRetryClicked=false,transportExtensionUsed=false;
  const readState={consecutiveReadFailures:0};
  while(Date.now()<deadline) {
    const currentUrl=page.url();
    let destination:string|null=null;
    try{destination=normalizeChatGPTUrl(currentUrl);}catch{
      if(!tolerateRolloverNavigation(currentUrl,Date.now()-start))
        throw new Error(`New ChatGPT tab navigated outside an authorized direct conversation URL (class=${rolloverUrlClass(currentUrl)})`);
    }
    let finalCandidate=false;
    if(destination) {
      const snapshot=await inspectAfterSend(page,destination,readState,deadline);
      if(!snapshot){last='';stableSince=Date.now();continue;}
      const banner=await visibleLongTaskBanner(page,snapshot.lastAssistant);
      const newestUserMatchesPrompt=snapshot.userCount>0 &&
        matchesSubmittedUserPrompt(await lastVisibleUserPromptSha256(page),prompt);
      if(banner==='interrupted'&&newestUserMatchesPrompt&&!interruptedSeen) {
        interruptedSeen=true;
        if(!transportExtensionUsed){
          deadline=interruptedDeadline(start,deadline,Date.now(),
            timeoutMs===DEFAULT_BROWSER_TURN_TIMEOUT_MS);
          transportExtensionUsed=true;
        }
        console.warn('New ChatGPT connection interrupted; waiting without a second Send');
      }
      if(banner==='delivery-timeout'&&!deliveryRetryClicked&&newestUserMatchesPrompt) {
        const clicked=await clickDeliveryRetryOnce(page,destination,true,false);
        if(clicked) {
          deliveryRetryClicked=true;
          if(!transportExtensionUsed){
            deadline=interruptedDeadline(start,deadline,Date.now(),
              timeoutMs===DEFAULT_BROWSER_TURN_TIMEOUT_MS);
            transportExtensionUsed=true;
          }
          console.warn('New ChatGPT delivery timed out; clicked Retry once on the existing message');
          await delay(Math.min(3000,Math.max(0,deadline-Date.now())));
          continue;
        }
      }
      if(banner===null&&shouldReloadBlankNewChat(Date.now()-start,snapshot,reloadedBlank)) {
        reloadedBlank=true;
        // Reload only the already-known exact conversation, never the old tab
        // or an uncertain noncanonical origin; do not click Send again.
        console.warn('New ChatGPT conversation has no visible answer after two minutes; refreshing the same authorized tab once without resending');
        await reloadBlankDirectNewChat(page,destination);
        continue;
      }
      if(!snapshot.generating&&banner===null&&visibleChatResponseFailed(snapshot.lastAssistant)) {
        failureSince??=Date.now();
        if(Date.now()-failureSince>=5000)
          throw new Error('New ChatGPT reply failed to load; first Send may have committed; do not replay');
      }else failureSince=null;
      if(snapshot.userCount>0 && snapshot.assistantCount>0 && snapshot.lastAssistant &&
        newestUserMatchesPrompt) {
        if(snapshot.lastAssistant!==last){last=snapshot.lastAssistant;stableSince=Date.now();}
        finalCandidate=!snapshot.generating && banner===null && finalMarker.test(snapshot.lastAssistant.trim());
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
