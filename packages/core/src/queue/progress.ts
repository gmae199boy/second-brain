import type { ProcessAbiEvent } from '../process-abi/codec.js';

/** Core work reports the same progress event shape as supervised work. */
export type WorkProgress = Extract<ProcessAbiEvent,{type:'progress'}>;
export type WorkProgressSink = (event:WorkProgress)=>void|Promise<void>;
/** A stuck observer is disabled only for the current work attempt. */
export function workProgress(sink:WorkProgressSink|undefined) {
  let disabled=false;
  return async (stage:'source_page'|'upload_chunk',count:number):Promise<void>=>{
    if(!sink||disabled)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const delivered=Promise.resolve().then(()=>sink({abi:1,type:'progress',message:`${stage} ${count}`})).then(()=>true,()=>true);
      const completed=await Promise.race([delivered,new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),1000);})]);
      if(!completed)disabled=true;
    } finally {if(timer)clearTimeout(timer);}
  };
}
