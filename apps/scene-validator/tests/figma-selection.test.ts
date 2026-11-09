import test from 'node:test';
import assert from 'node:assert/strict';
import {requestedFile,matching,chooseFrames,resolveFrames} from '../src/figma-selection.js';
import {discoveryCode,frameExportCode} from '../src/figma-code.js';
const catalog=[{fileKey:'aaa',name:'хакатон?'},{fileKey:'bbb',name:'проверка-123'}];
const candidate=(id:string,name:string,type='SECTION',frameIds=['10:1'])=>({id,name,type,frameIds,pageId:'1:1',pageName:'Page 1'});
test('File selection normalizes punctuation/digit spacing and uses newest explicit reference',()=>{
 assert.equal(requestedFile(['в проекте проверка 123 возьми кадры'],catalog).fileKey,'bbb');
 assert.equal(requestedFile(['https://www.figma.com/design/aaa/old?node-id=1-3','возьми из проверка123'],catalog).fileKey,'bbb');
 assert.deepEqual(requestedFile(['https://www.figma.com/design/bbb/new?node-id=1-3 - тут'],catalog),{fileKey:'bbb',name:'проверка-123',nodeId:'1:3'});
 assert.equal(matching([{name:'тест 1'},{name:'тест 10'}],['возьми тест1'])[0].name,'тест 1');
});
test('Unique known file and unique storyboard do not require directory labels',()=>{
 assert.equal(requestedFile(['возьми кадры'],[catalog[0]]).fileKey,'aaa');
 const group=candidate('2:1','тест2'),page=candidate('1:1','Page 1','PAGE'),frame=candidate('10:1','Scene','FRAME');
 assert.equal(chooseFrames([page,group,frame],['возьми кадры']).id,group.id);
 assert.equal(chooseFrames([page,frame],['возьми кадры']).id,page.id);
 assert.throws(()=>chooseFrames([page,group,candidate('2:2','other','SECTION',['10:2'])],['возьми кадры']),/несколько/);
});
test('Direct frame link chooses that frame; named child can narrow a section link',()=>{
 const frame=candidate('10:1','First','FRAME');
 assert.equal(chooseFrames([frame],['отсюда'],frame).id,frame.id);
 const section=candidate('2:1','Storyboard','SECTION',['10:1','10:2']);
 assert.equal(chooseFrames([section,frame],['возьми First'],section).id,frame.id);
});
function mock(){
 const nodes=new Map<string,any>();
 const node=(id:string,name:string,type:string,children:any[]=[])=>{const n:any={id,name,type,x:0,y:0,absoluteTransform:[[1,0,0],[0,1,0]],children};nodes.set(id,n);for(const c of children)c.parent=n;return n;};
 const frame=node('10:1','Scene','FRAME',[node('11:1','Internal layout','FRAME')]);
 const section=node('2:1','тест 1','SECTION',[node('3:1','Nested group','GROUP',[frame])]);
 const page=node('1:1','Page 1','PAGE',[section]);
 const other=node('1:2','Page 2','PAGE',[]);const root=node('0:0','Document','DOCUMENT',[page,other]);
 const switches:string[]=[];
 const figma:any={root,currentPage:page,getNodeByIdAsync:async(id:string)=>nodes.get(id),setCurrentPageAsync:async(p:any)=>{figma.currentPage=p;switches.push(p.id);}};
 const client:any={call:async(name:string,args:any)=>{
  if(name==='create_session')return {structuredContent:{sessionId:'session'}};
  assert.equal(args.sessionId,'session');
  let calls=0;const local={...figma,currentPage:page,setCurrentPageAsync:async(p:any)=>{local.currentPage=p;calls++;switches.push(p.id);}};
  const result=await new (Object.getPrototypeOf(async function(){}).constructor)('figma',args.code)(local);
  assert.ok(calls<=1,'one page switch per MCP call');
  return {structuredContent:result};
 }};
 return {figma,client,switches};
}
test('Resolver searches pages without requiring page name and keeps nested frame ancestry',async()=>{
 const m=mock();const r=await resolveFrames(m.client,{fileKey:'aaa',name:'file'},['возьми тест1']);
 assert.equal(r.id,'2:1');assert.deepEqual(r.frameIds,['10:1']);assert.deepEqual([...new Set(m.switches)].sort(),['1:1','1:2']);
});
test('Resolver follows node-id without asking for sole page or section name',async()=>{
 const m=mock();const r=await resolveFrames(m.client,{fileKey:'aaa',name:'file',nodeId:'10:1'},['возьми отсюда']);
 assert.equal(r.id,'10:1');assert.deepEqual(r.frameIds,['10:1']);assert.deepEqual(m.switches,['1:1']);
});
test('Discovery accepts page, nested group and individual frame as export roots',async()=>{
 const {figma}=mock();const execute=Object.getPrototypeOf(async function(){}).constructor;
 for(const sectionId of ['1:1','2:1','3:1','10:1']){
  const result=await new execute('figma',discoveryCode({fileKey:'aaa',pageId:'1:1',sectionId}))(figma);
  assert.deepEqual(result.frames.map((f:any)=>f.id),['10:1']);
 }
 assert.ok((await frameExportCode({fileKey:'aaa',pageId:'1:1',sectionId:'10:1'},'10:1')).length<50000);
});
