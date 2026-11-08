import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

const maxInput=50*1024*1024, maxExpanded=200*1024*1024, maxText=5_000_000;
class TooLarge extends Error {}
let mammothCalls=0;
const chunks:Buffer[]=[];let inputSize=0;for await(const chunk of process.stdin){const b=Buffer.from(chunk as Buffer);if(b.length>maxInput-inputSize){process.stdout.write(JSON.stringify({kind:'too_large'}));process.exit(0);}chunks.push(b);inputSize+=b.length;}
const input=Buffer.concat(chunks,inputSize);
const pdf=input.subarray(0,5).equals(Buffer.from('%PDF-'));
const zip=input.length>=4 && input.readUInt32LE(0)===0x04034b50;
const mode=process.argv[2];
async function readZip(only?:ReadonlySet<string>):Promise<Map<string,Buffer>> {
  const z:ZipFile=await new Promise((resolve,reject)=>fromBuffer(input,{lazyEntries:true,validateEntrySizes:false,strictFileNames:true},(e,v)=>e?reject(e):resolve(v!)));
  const result=new Map<string,Buffer>();let total=0,count=0;
  await new Promise<void>((resolve,reject)=>{
    z.on('error',reject); z.on('end',resolve);
    z.on('entry',(entry:Entry)=>{void (async()=>{
      if(++count>10000) throw new TooLarge('ZIP 항목 상한');
      const name=entry.fileName;
      if(name.startsWith('/')||name.includes('\\')||name.split('/').some(x=>x==='..'||x==='.')||result.has(name)||(entry.generalPurposeBitFlag&1)!==0) throw new Error('잘못된 ZIP 경로');
      if(!Number.isSafeInteger(entry.uncompressedSize)) throw new Error('잘못된 ZIP 크기');
      if(only&&!only.has(name)){result.set(name,Buffer.alloc(0));z.readEntry();return;}
      if(entry.uncompressedSize>maxExpanded-total) throw new TooLarge('ZIP 해제 크기 상한');
      if(name.endsWith('/')) {result.set(name,Buffer.alloc(0));z.readEntry();return;}
      const stream=await new Promise<import('node:stream').Readable>((res,rej)=>z.openReadStream(entry,(e,v)=>e?rej(e):res(v!)));
      const parts:Buffer[]=[];let n=0;
      for await(const chunk of stream){const b=Buffer.from(chunk as Buffer);if(b.length>maxExpanded-total-n){stream.destroy();throw new TooLarge('ZIP 해제 크기 상한');}parts.push(b);n+=b.length;}
      if(n!==entry.uncompressedSize)throw new Error('ZIP 해제 크기가 일치하지 않습니다');
      total+=n;result.set(name,Buffer.concat(parts,n));z.readEntry();
    })().catch(e=>{z.close();reject(e);});});z.readEntry();
  }); return result;
}
const TRANS_WORD='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const STRICT_WORD='http://purl.oclc.org/ooxml/wordprocessingml/main';
const TRANS_REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const STRICT_REL='http://purl.oclc.org/ooxml/officeDocument/relationships/';
const PACKAGE_REL='http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES='http://schemas.openxmlformats.org/package/2006/content-types';

/** Mammoth reads ZIP XML as UTF-8; normalize OOXML UTF-16 before handing it over. */
function decodeXml(bytes:Buffer):string {
 let encoding:'utf-8'|'utf-16le'|'utf-16be'='utf-8', offset=0;
 if(bytes[0]===0xff&&bytes[1]===0xfe){encoding='utf-16le';offset=2;}
 else if(bytes[0]===0xfe&&bytes[1]===0xff){encoding='utf-16be';offset=2;}
 else if(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf){offset=3;}
 else if(bytes[0]===0x3c&&bytes[1]===0)encoding='utf-16le';
 else if(bytes[0]===0&&bytes[1]===0x3c)encoding='utf-16be';
 let value=new TextDecoder(encoding,{fatal:true}).decode(bytes.subarray(offset));
 const decl=/^\s*<\?xml\s+[^?]*\?>/i.exec(value)?.[0];
 const declared=decl?.match(/\bencoding\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.toLowerCase();
 if(declared && !(declared==='utf-8'&&encoding==='utf-8') && !(declared==='utf-16'&&encoding.startsWith('utf-16')) && declared!==encoding) throw new Error('지원하지 않는 XML 인코딩');
 if(/<!DOCTYPE|<!ENTITY/i.test(value))throw new Error('외부 XML 선언은 허용하지 않습니다');
 if(decl)value=value.replace(decl,decl.replace(/\bencoding\s*=\s*['"][^'"]+['"]/i,'encoding="UTF-8"'));
 return value;
}
function xml(bytes:Buffer):Document {let error=false;const d=new DOMParser({errorHandler:{warning:()=>{error=true;},error:()=>{error=true;},fatalError:()=>{error=true;}}}).parseFromString(decodeXml(bytes),'application/xml');if(error||!d.documentElement)throw new Error('잘못된 XML');return d as unknown as Document;}
/** Resolve a package-internal URI, refusing schemes, fragments and root escapes. */
function partPath(target:string,base=''):string {
 if(!target||/[?#\\]/.test(target)||/^[a-z][a-z0-9+.-]*:/i.test(target)||target.startsWith('//'))throw new Error('잘못된 OOXML 관계');
 let decoded:string;try{decoded=decodeURIComponent(target);}catch{throw new Error('잘못된 OOXML 경로');}
 if(/[\\\0?#]/.test(decoded)||decoded.startsWith('//'))throw new Error('잘못된 OOXML 경로');
 const parts=decoded.startsWith('/')?[]:base.split('/').filter(Boolean);
 for(const part of decoded.split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw new Error('OOXML 경로가 루트를 벗어났습니다');parts.pop();}else parts.push(part);}
 if(!parts.length)throw new Error('빈 OOXML 경로');return parts.join('/');
}
interface DocxPackage {mainPath:string; main:Document; entries:Map<string,Buffer>}
function mainPathOf(entries:Map<string,Buffer>):string|null {
 const types=entries.get('[Content_Types].xml'),rels=entries.get('_rels/.rels');if(!types||!rels)return null;
 const t=xml(types),r=xml(rels);
 const matches=Array.from(r.getElementsByTagNameNS(PACKAGE_REL,'Relationship')).filter(x=>[TRANS_REL+'officeDocument',STRICT_REL+'officeDocument'].includes(x.getAttribute('Type')??''));
 if(matches.length!==1||matches[0]!.getAttribute('TargetMode')==='External')return null;
 const target=matches[0]!.getAttribute('Target');if(!target)return null;const mainPath=partPath(target);
 const hasType=Array.from(t.getElementsByTagNameNS(CONTENT_TYPES,'Override')).some(x=>{const p=x.getAttribute('PartName');return !!p&&partPath(p)===mainPath&&x.getAttribute('ContentType')==='application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';});
 if(!hasType)return null;
 return mainPath;
}
function inspectDocx(entries:Map<string,Buffer>):DocxPackage|null {
 const mainPath=mainPathOf(entries);if(!mainPath)return null;const bytes=entries.get(mainPath);if(!bytes?.length)return null;
 const main=xml(bytes),root=main.documentElement;
 if(![TRANS_WORD,STRICT_WORD].includes(root.namespaceURI??'')||root.localName!=='document')return null;
 return {mainPath,main,entries};
}

/** One Mammoth raw-text call for the whole document; marker grammar is verified. */
async function extractDocx(docx:DocxPackage, add:(index:number,text:string)=>void):Promise<void> {
 const {main,mainPath,entries}=docx, serializer=new XMLSerializer(), ns=main.documentElement.namespaceURI!;
 const body=main.getElementsByTagNameNS(ns,'body')[0];if(!body)throw new Error('문서 본문 없음');
 const paragraphs=Array.from(body.getElementsByTagNameNS(ns,'p'));
 // Match Mammoth's calculateRowSpans over the emitted rows/cells, including
 // colSpan and deleted rows.  A continuation can disappear only if a previous
 // emitted cell occupied its starting column; an orphan becomes an anchor.
 const children=(element:Element)=>Array.from(element.childNodes).filter((n):n is Element=>n.nodeType===1);
 const first=(element:Element,name:string)=>children(element).find(e=>e.namespaceURI===ns&&e.localName===name);
 const wrappers=new Set(['customXml','ins','moveFromRangeEnd','moveFromRangeStart','moveTo','moveToRangeEnd','moveToRangeStart','object','smartTag']);
 const collect=(container:Element,target:'tr'|'tc'):Element[]=>{
  const items:Element[]=[];
  const walk=(parent:Element)=>{for(const e of children(parent)){
   if(e.namespaceURI==='http://schemas.openxmlformats.org/markup-compatibility/2006'&&e.localName==='AlternateContent'){const fallback=children(e).find(x=>x.namespaceURI===e.namespaceURI&&x.localName==='Fallback');if(fallback)walk(fallback);continue;}
   if(e.namespaceURI!==ns)continue;
   if(e.localName===target){if(target==='tr'){const props=first(e,'trPr');if(props&&first(props,'del'))continue;}items.push(e);continue;}
   if(e.localName==='sdt'){const content=first(e,'sdtContent');if(content)walk(content);continue;}
   if(wrappers.has(e.localName)){walk(e);continue;}
  }};walk(container);return items;
 };
 const removedCells=new Set<Element>();
 for(const table of Array.from(body.getElementsByTagNameNS(ns,'tbl'))){
  const rows=collect(table,'tr');
  const cellRows=rows.map(row=>collect(row,'tc'));
  const columns=new Set<number>();
  for(const row of cellRows){let column=0;for(const cell of row){const props=first(cell,'tcPr'),merge=props&&first(props,'vMerge'),value=merge?.getAttributeNS(ns,'val');const continuation=!!merge&&(!value||value==='continue');
   if(continuation&&columns.has(column))removedCells.add(cell);else columns.add(column);
   const span=props&&first(props,'gridSpan'),raw=span?.getAttributeNS(ns,'val');column+=raw?Number.parseInt(raw,10):1;
  }}
 }
 // Mammoth deterministically selects mc:Fallback and omits deleted content.
 // Those paragraphs retain their source numbers but cannot emit marker runs.
 const active=paragraphs.map(p=>{let parent=p.parentNode;while(parent&&parent!==body){if(parent.nodeType===1){const element=parent as Element;
  if((element.namespaceURI==='http://schemas.openxmlformats.org/markup-compatibility/2006'&&element.localName==='Choice')||(element.namespaceURI===ns&&element.localName==='del'))return false;
  if(['http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing','http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing'].includes(element.namespaceURI??'')&&['anchor','inline'].includes(element.localName))return false;
  if(element.namespaceURI===ns&&element.localName==='tr'){const props=Array.from(element.childNodes).find(n=>n.nodeType===1&&(n as Element).namespaceURI===ns&&(n as Element).localName==='trPr') as Element|undefined;if(props&&Array.from(props.childNodes).some(n=>n.nodeType===1&&(n as Element).namespaceURI===ns&&(n as Element).localName==='del'))return false;}
 }parent=parent.parentNode;}return true;});
 // Verify the chosen prefix against decoded text, not encoded XML bytes.
 let prefix='';const sourceText=body.textContent??'';
 for(let n=0;n<8;n++){const candidate=`__BRAIN_${randomBytes(16).toString('hex')}_`;if(!sourceText.includes(candidate)){prefix=candidate;break;}}
 if(!prefix)throw new Error('문단 표식을 만들 수 없습니다');
 const token=(kind:'S'|'E'|'N',id:number)=>`${prefix}${kind}${id}__`;
 const run=(text:string)=>{const r=main.createElementNS(ns,'w:r'),t=main.createElementNS(ns,'w:t');t.appendChild(main.createTextNode(text));r.appendChild(t);return r;};
 for(let i=0;i<paragraphs.length;i++){
  if(!active[i])continue;
  const p=paragraphs[i]!,start=run(token('S',i+1)),end=run(token('E',i+1));
  const props=Array.from(p.childNodes).find(n=>n.nodeType===1&&(n as Element).namespaceURI===ns&&(n as Element).localName==='pPr');
  p.insertBefore(start,props ? props.nextSibling : p.firstChild);p.appendChild(end);
 }
 // Mammoth's raw-text converter omits break elements; convert them to marker
 // text before its single parse, then restore explicit line breaks afterwards.
 const breaks=Array.from(body.getElementsByTagName('*')).filter(e=>e.namespaceURI===ns&&(e.localName==='br'||e.localName==='cr'));
 for(const element of breaks){const text=main.createElementNS(ns,'w:t');text.appendChild(main.createTextNode(token('N',0)));element.parentNode?.replaceChild(text,element);}
 const zip=new JSZip();
 for(const [name,bytes] of entries){
  if(name.endsWith('/'))continue;
  if(name===mainPath){zip.file(name,serializer.serializeToString(main));continue;}
  if(name.endsWith('.xml')||name.endsWith('.rels')){
   const document=xml(bytes);
   if(name.endsWith('.rels'))for(const rel of Array.from(document.getElementsByTagNameNS(PACKAGE_REL,'Relationship'))){
    const type=rel.getAttribute('Type');if(type?.startsWith(STRICT_REL))rel.setAttribute('Type',TRANS_REL+type.slice(STRICT_REL.length));
    const target=rel.getAttribute('Target');if(target&&rel.getAttribute('TargetMode')!=='External'){
      const base=name==='_rels/.rels'?'':name.replace(/\/_rels\/[^/]+\.rels$/,'');
      rel.setAttribute('Target','/'+partPath(target,base));
    }
   }
   zip.file(name,serializer.serializeToString(document));
  }else zip.file(name,bytes);
 }
 const packed=await zip.generateAsync({type:'nodebuffer',compression:'STORE'});
 mammothCalls++;
 const raw=(await mammoth.extractRawText({buffer:packed})).value;
 const result=Array.from({length:paragraphs.length},()=>[] as string[]),stack:number[]=[],seen=new Set<number>();
 const pattern=new RegExp(`${prefix}(S|E|N)([0-9]+)__`,'g');let cursor=0,match:RegExpExecArray|null;
 while((match=pattern.exec(raw))!==null){
  const between=raw.slice(cursor,match.index);if(stack.length){const index=stack[stack.length-1]!-1;result[index]!.push(between);}else if(between.trim())throw new Error('문단 밖 텍스트를 매핑할 수 없습니다');
  const id=Number(match[2]);if(match[1]==='S'){if(id<1||id>paragraphs.length||seen.has(id))throw new Error('문단 표식 중복 오류');seen.add(id);stack.push(id);}
  else if(match[1]==='N'){if(id!==0||!stack.length)throw new Error('줄바꿈 표식 오류');const index=stack[stack.length-1]!-1;result[index]!.push('\n');}
  else {if(stack.pop()!==id)throw new Error('문단 종료 표식 오류');if(raw.slice(pattern.lastIndex,pattern.lastIndex+2)==='\n\n')pattern.lastIndex+=2;}
  cursor=pattern.lastIndex;
 }
 // A candidate continuation can disappear after Mammoth parses the table.
 // Keep its markers in the input: if Mammoth disables merging (for example due
 // to a non-cell sibling), its actual emitted text is preserved and verified.
 const inRemovedCell=(p:Element)=>{let parent=p.parentNode;while(parent&&parent!==body){if(parent.nodeType===1&&removedCells.has(parent as Element))return true;parent=parent.parentNode;}return false;};
 if(stack.length||raw.slice(cursor).trim()||paragraphs.some((p,i)=>active[i]&&!seen.has(i+1)&&!inRemovedCell(p)))throw new Error('문단 표식이 누락되었습니다');
 result.forEach((parts,i)=>{const text=parts.join('');if(text.includes(prefix))throw new Error('문단 표식 충돌');add(i+1,text);});
}
async function main(){
 let docx:DocxPackage|null=null;
 if(zip){
  const metadata=await readZip(new Set(['[Content_Types].xml','_rels/.rels']));const path=mainPathOf(metadata);if(!path)return {kind:'unsupported'};
  const identity=await readZip(new Set(['[Content_Types].xml','_rels/.rels',path]));if(!inspectDocx(identity))return {kind:'unsupported'};
  try{docx=inspectDocx(await readZip());}catch(e){if(e instanceof TooLarge&&mode==='detect')return {kind:'docx_too_large'};throw e;}if(!docx)return {kind:'unsupported'};
 }
 if(!pdf&&!docx)return {kind:'unsupported'};
 if(mode==='detect')return {kind:pdf?'pdf':'docx'};
 const blocks:{index:number;text:string}[]=[];let total=0;
 const add=(index:number,text:string)=>{let n=0;for(const _ of text){if(++n>maxText-total)throw new TooLarge('추출 문자 상한');}total+=n;blocks.push({index,text});};
 if(pdf){const packageDir=dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));const task=getDocument({data:new Uint8Array(input),useSystemFonts:false,cMapUrl:join(packageDir,'cmaps')+sep,cMapPacked:true,standardFontDataUrl:join(packageDir,'standard_fonts')+sep});try{const doc=await task.promise;if(doc.numPages>2000)throw new TooLarge('PDF 쪽 상한');for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);const reader=page.streamTextContent().getReader();let text='';let previous:{x:number;y:number;ux:number;uy:number;width:number;height:number;dir:string}|undefined;for(;;){const item=await reader.read();if(item.done)break;for(const part of item.value.items){if('str' in part){
 const a=part.transform[0]??0,b=part.transform[1]??0,x=part.transform[4]??0,y=part.transform[5]??0;const scale=Math.hypot(a,b),ux=scale?a/scale:1,uy=scale?b/scale:0,height=Math.max(part.height||0,scale,1);let separator='';
 if(previous&&part.str&&previous.dir!=='ttb'&&part.dir!=='ttb'){
  const dx=x-previous.x,dy=y-previous.y,normal=Math.abs(-previous.uy*dx+previous.ux*dy),advance=previous.ux*dx+previous.uy*dy-previous.width;
  if(normal>Math.max(previous.height,height)*0.6&&!text.endsWith('\n'))separator='\n';else if(!/\s$/u.test(text)&&!/^\s/u.test(part.str)&&advance>Math.max(0.5,Math.min(previous.height,height)*0.2))separator=' ';
 }
 const t=separator+part.str+(part.hasEOL?'\n':'');let n=0;for(const _ of t){if(++n>maxText-total)throw new TooLarge('추출 문자 상한');}total+=n;text+=t;
 previous=part.hasEOL?undefined:{x,y,ux,uy,width:part.width,height,dir:part.dir};
 }}}blocks.push({index:i,text});page.cleanup();}}finally{await task.destroy();}}
 else if(docx)await extractDocx(docx,add);
 return {kind:pdf?'pdf':'docx',blocks,...(!pdf?{mammothCalls}:{})};
}
try{const result=await main();process.stdout.write(JSON.stringify(result));}catch(e){process.stdout.write(JSON.stringify({kind:e instanceof TooLarge?'too_large':mode==='detect'?'unsupported':'failed',message:e instanceof Error?e.message:'추출 실패'}));}
