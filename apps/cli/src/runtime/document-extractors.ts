import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_EXTRACTORS, type DocumentExtractor, type DocumentExtractorPiece } from 'second_brain';

type Answer={kind:'pdf'|'docx'|'docx_too_large'|'unsupported'|'too_large'|'failed';message?:string;blocks?:{index:number;text:string}[];mammothCalls?:number};
const MAX_INPUT=50*1024*1024, MAX_OUTPUT=30*1024*1024;
export async function runDocumentParser(bytes:Uint8Array,mode:'detect'|'extract',timeout=60_000, observe?:(child:ChildProcess)=>void, launch?:()=>ChildProcess):Promise<Answer>{
 if(bytes.length>MAX_INPUT)return {kind:'too_large',message:'입력 크기 상한 초과'};
 return await new Promise(resolve=>{
  const local=new URL('./document-parser-child.js',import.meta.url);const script=existsSync(local)?local:new URL('../../dist/runtime/document-parser-child.js',import.meta.url);
  const child=launch?launch():spawn(process.execPath,['--max-old-space-size=256',fileURLToPath(script),mode],{stdio:['pipe','pipe','pipe']});
  observe?.(child);
  const parts:Buffer[]=[];let size=0,done=false;let killed:Answer|undefined;
  const finish=(result:Answer)=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};
  const timer=setTimeout(()=>{killed={kind:'failed',message:'문서 추출 시간 초과'};child.kill('SIGKILL');},timeout);
  child.on('error',()=>finish({kind:'failed',message:'문서 추출 프로세스를 시작할 수 없습니다'}));
  child.stdout!.on('data',(data:Buffer)=>{if(data.length>MAX_OUTPUT-size){killed={kind:'too_large',message:'추출 결과 크기 초과'};child.kill('SIGKILL');return;}parts.push(data);size+=data.length;});
  child.stderr!.resume();child.stdin!.on('error',()=>{});child.stdin!.end(bytes);
  child.on('close',code=>{if(killed){finish(killed);return;}if(code!==0){finish({kind:'failed',message:'문서 추출 프로세스가 종료되었습니다'});return;}try{finish(JSON.parse(Buffer.concat(parts,size).toString('utf8')) as Answer);}catch{finish({kind:'failed',message:'문서 추출 결과가 올바르지 않습니다'});}});
 });
}
export function createDocumentExtractor(runParser:typeof runDocumentParser=runDocumentParser):DocumentExtractor {return {name:'pdf-docx',async detectCarry(bytes){if(bytes.length>=5&&bytes[0]===37&&bytes[1]===80&&bytes[2]===68&&bytes[3]===70&&bytes[4]===45)return true;if(bytes.length<4||bytes[0]!==0x50||bytes[1]!==0x4b||bytes[2]!==3||bytes[3]!==4)return false;const result=await runParser(bytes,'detect');return result.kind==='docx'||result.kind==='docx_too_large'?true:result.kind==='too_large'?'too_large':result.kind==='unsupported'?false:null;},async detect(bytes){
 if(bytes.length>=5&&bytes[0]===37&&bytes[1]===80&&bytes[2]===68&&bytes[3]===70&&bytes[4]===45)return 'application/pdf';
 if(bytes.length<4||bytes[0]!==0x50||bytes[1]!==0x4b||bytes[2]!==3||bytes[3]!==4)return null;
 const result=await runParser(bytes,'detect');return result.kind==='docx'||result.kind==='docx_too_large'||result.kind==='failed'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':null;
},async extract(bytes,media,params){const result=await runParser(bytes,'extract');if(result.kind==='too_large'||result.kind==='failed'||result.kind==='unsupported')return {ok:false,message:result.message??'문서 추출 실패',...(result.kind==='too_large'?{tooLarge:true}:{})};
 const pieces:DocumentExtractorPiece[]=[];let count=0;
 for(const block of result.blocks??[]){const points=Array.from(block.text);count+=points.length;if(count>5_000_000)return {ok:false,tooLarge:true,message:'추출 문자 상한 초과'};const target=Math.max(1,params.targetChars),overlap=Math.max(0,Math.min(params.overlapChars,target-1));for(let at=0;at<points.length;){const end=Math.min(points.length,at+target),body=points.slice(at,end).join('');if(body.trim())pieces.push(media==='application/pdf'?{body,page:block.index,chunkLocator:{type:'pdf',page:block.index}}:{body,page:null,chunkLocator:{type:'docx',block:block.index}});if(end===points.length)break;at=end-overlap;}}
 return {ok:true,pieces};}};}
export const runtimeDocumentExtractors:readonly DocumentExtractor[]=[createDocumentExtractor(),...DOCUMENT_EXTRACTORS];
