/** Shared by the real race and the isolated timeout fixture. */
export class LifecycleStopped extends Error { constructor() { super('lifecycle stopped'); } }
export function maskedError(value:unknown, mask:(text:string)=>string, seen=new WeakSet<object>()):unknown {
  if(typeof value !== 'object' || value===null) return typeof value==='string' ? mask(value) : value;
  if(seen.has(value)) return '[circular]';
  seen.add(value);
  if(value instanceof Error) {
    const result:{name:string;message:string;errors?:unknown[];cause?:unknown}={name:mask(value.name),message:mask(value.message)};
    if(value instanceof AggregateError) result.errors=Array.from(value.errors,(item:unknown)=>maskedError(item,mask,seen));
    if(value.cause!==undefined) result.cause=maskedError(value.cause,mask,seen);
    return result;
  }
  if(Array.isArray(value)) return value.map(item=>maskedError(item,mask,seen));
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[mask(key),maskedError(item,mask,seen)]));
}
export async function settleCleanup(steps:Array<()=>void|Promise<void>>, primary?:unknown, mask:(s:string)=>string=(s)=>s, diagnostic:()=>unknown=()=>undefined) {
  const failures:unknown[]=[]; if(primary!==undefined) failures.push(primary);
  for(const step of steps) try { await step(); } catch (cause) { failures.push(cause); }
  if(failures.length) {
    const sanitized=failures.map(error=>maskedError(error,mask));
    throw new AggregateError(sanitized,JSON.stringify({primary:sanitized[0],additional:sanitized.slice(1),child:diagnostic()}));
  }
}
export function onceCleanup(action:()=>Promise<void>) { let promise:Promise<void>|undefined; return ()=>promise ??= action(); }
export function createLifecycle(options:{interrupt:Array<()=>void|Promise<void>>;dispose:Array<()=>void|Promise<void>>;mask:(s:string)=>string;diagnostic:()=>unknown}) {
  let stopped=false, primary:unknown, body:Promise<void>|undefined, bodyDone=false;
  const check=()=>{if(stopped) throw new LifecycleStopped();};
  const run=(action:()=>Promise<void>)=>{
    if(body) throw Error('body already started');
    body=(async()=>{try {check(); await action();} catch(error) {if(!(error instanceof LifecycleStopped)) primary ??= error;} finally {bodyDone=true;}})();
    return body;
  };
  const finish=onceCleanup(async()=>{
    stopped=true;
    if(!bodyDone && primary===undefined) primary=Error('test finished before body settled');
    await settleCleanup([...options.interrupt,async()=>{if(body) await body;},...options.dispose],primary,options.mask,options.diagnostic);
  });
  return {check,run,finish};
}
