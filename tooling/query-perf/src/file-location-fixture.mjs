// Deterministic synthetic rows; IDs are valid PostgreSQL UUIDs without a
// version restriction. The last four rows are independent warmup/samples.
export const fixture = {version:1, rows:100000, warmups:1, samples:3};
export const stamp = '2026-01-02T03:04:05.000Z';
export const id = n => `abcdef00-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
export const fileId = n => `abcdef01-0000-0000-0000-${n.toString(16).padStart(12,'0')}`;
export const expectedLocation = (n, deletedAt=null) => ({id:id(n),fileId:fileId(n),storeKind:'local',locator:`synthetic/${n}`,ownership:'brain',deletedAt});
export const expected = (kind,n) => kind==='read' ? {ok:true,location:expectedLocation(n)} : kind==='list' ? {ok:true,locations:listExpected(n)} : {ok:true,deletedAt:stamp,marked:true};
export const listExpected = (n, rows=fixture.rows) => {
 const offset=rows-n;
 if(offset<0||offset>5) return [expectedLocation(n)];
 const a=offset*2+1, b=a+1;
 return [{id:id(a),fileId:fileId(n),storeKind:'local',locator:`a/${a}`,ownership:'brain',deletedAt:null},expectedLocation(n),{id:id(b),fileId:fileId(n),storeKind:'local',locator:`z/${b}`,ownership:'external',deletedAt:null}];
};
export function matrixInputs(n) {
 const loc=id(n), file=fileId(n), missing=id(999999), missingFile=fileId(999999);
 return [
  {name:'canonical',loc,file,hit:true},{name:'missing',loc:missing,file:missingFile,hit:false},
  {name:'uppercase',loc:loc.toUpperCase(),file:file.toUpperCase(),hit:false},
  {name:'mixed',loc:'Ab'+loc.slice(2),file:'Ab'+file.slice(2),hit:false},
  {name:'braces',loc:`{${loc}}`,file:`{${file}}`,hit:false},
  {name:'no-hyphens',loc:loc.replaceAll('-',''),file:file.replaceAll('-',''),hit:false},
  {name:'leading-space',loc:` ${loc}`,file:` ${file}`,hit:false},
  {name:'trailing-space',loc:`${loc} `,file:`${file} `,hit:false},
  {name:'not-uuid',loc:'not-uuid',file:'not-uuid',hit:false},
  {name:'empty',loc:'',file:'',hit:false},
  {name:'null',loc:null,file:null,hit:false},
  {name:'undefined',loc:undefined,file:undefined,hit:false}
 ];
}
export function matrixOracle(rows=fixture.rows) {
 const n=rows-6, missing={ok:false,code:'FILE_LOCATION_NOT_FOUND',message:'파일 위치가 없습니다'};
 const invalid={ok:false,code:'DB_UNAVAILABLE',message:'파일 위치를 표시할 수 없습니다: file_locations.deleted_at cannot hold this instant: 시각은 올바른 Date여야 합니다'};
 return matrixInputs(n).map(({name,hit})=>({name,
  read:hit?{ok:true,location:expectedLocation(n)}:missing,
  list:hit?{ok:true,locations:[expectedLocation(n)]}:{ok:true,locations:[]},
  first:hit?{ok:true,deletedAt:stamp,marked:true}:missing,
  repeated:hit?{ok:true,deletedAt:stamp,marked:false}:missing,
  invalid,before:expectedLocation(n,name==='canonical'?null:stamp),after:expectedLocation(n,stamp)}));
}
