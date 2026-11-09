import { expect,it } from 'vitest';
import { workProgress } from '../src/queue/progress.js';

it('progress delivers ordered callbacks and cancellation before returning',async()=>{
 const events:string[]=[];let cancelled=false;const sink=async(event:{message?:string})=>{events.push(event.message??'');if(events.length===1)cancelled=true;};
 const progress=workProgress(sink);await progress('source_page',1);expect(cancelled).toBe(true);await progress('source_page',2);expect(events).toEqual(['source_page 1','source_page 2']);
});
it('a stuck progress observer is bounded and receives no later out-of-order events',async()=>{
 const seen:string[]=[];const sink=(event:{message?:string})=>{seen.push(event.message??'');return new Promise<void>(()=>{});};
 const progress=workProgress(sink);await progress('upload_chunk',1);await progress('upload_chunk',2);expect(seen).toEqual(['upload_chunk 1']);
});
it('a rejecting progress observer does not block later progress',async()=>{
 const seen:string[]=[];const sink=async(event:{message?:string})=>{seen.push(event.message??'');if(seen.length===1)throw Error('synthetic');};
 const progress=workProgress(sink);await progress('upload_chunk',1);await progress('upload_chunk',2);expect(seen).toEqual(['upload_chunk 1','upload_chunk 2']);
});
