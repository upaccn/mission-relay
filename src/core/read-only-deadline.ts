/** Bound only side-effect-free Chrome preflight reads. Never use this around
 * browser Send/Retry, reservation commits, PI model execution or task writes:
 * a timeout cannot cancel an already submitted external effect.
 *
 * A connector finishing AFTER the deadline may be disposed by onLateValue
 * without navigating any user tab or altering a persisted request.
 */
export async function withReadOnlyDeadline<T>(
  operation:Promise<T>,
  timeoutMs=30_000,
  onLateValue?:(value:T)=>Promise<void>|void,
):Promise<T> {
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120_000)
    throw new Error('Invalid read-only browser preflight timeout');
  let expired=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  // Consume either late settlement so a timeout never leaks an unhandled
  // rejection, or leaves a late-acquired Playwriter connection open.
  void operation.then(value=>{
    if(expired&&onLateValue)void Promise.resolve()
      .then(()=>onLateValue(value)).catch(()=>{});
  },()=>{});
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{
          expired=true;
          reject(new Error('Read-only Chrome preflight timed out; no browser Send was authorized'));
        },timeoutMs);
      }),
    ]);
  } finally {
    if(timer)clearTimeout(timer);
  }
}
