
/** An explicit, human-managed ChatGPT conversation link, never an automation API. */
export function normalizeChatGPTUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Invalid ChatGPT conversation URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' ||
    url.username || url.password || url.port || url.search || url.hash ||
    !/^\/(?:c\/[A-Za-z0-9-]{20,}|g\/[A-Za-z0-9_-]+\/c\/[A-Za-z0-9-]{20,})\/?$/.test(url.pathname)) {
    throw new Error('Provide a direct https://chatgpt.com/c/<conversation-id> URL (no credentials, queries or fragments)');
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}
