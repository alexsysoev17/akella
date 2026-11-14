import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {renderVariant} from './render.js';
import {hash} from './storage.js';
import type {Layer,Resource,Variant} from './contracts.js';

/** Real original marks and real rendered faces, not generated approximations.
 * Two neutral backgrounds expose the shapes; brand rules determine allowed usage.
 */
export async function renderIdentitySheet(directory:string,resources:Resource[]){
  const fonts=resources.filter(r=>r.kind==='font'&&r.style!=='Variable');
  const label=fonts.find(r=>r.style==='Regular')??fonts[0];
  if(!label)return undefined;
  const logos=resources.filter(r=>r.kind==='logo');
  const layers:Layer[]=[];
  const add=(value:Partial<Layer>)=>layers.push({id:'specimen-'+layers.length,name:'Identity specimen',kind:'text',role:'support',
    x:30,y:0,width:1140,height:50,rotation:0,opacity:1,text:'',assetId:'',fontId:label.id,fontSize:24,
    lineHeight:1.1,color:'#171717',align:'left',shape:'rect',radius:0,...value});
  let y=20;
  for(const logo of logos){
    add({text:logo.id+' — '+logo.name,y});y+=40;
    add({kind:'shape',role:'panel',x:600,y,width:570,height:150,color:'#222222'});
    const height=90,width=height*(logo.width??300)/(logo.height??100);
    for(const x of [60,640])add({kind:'logo',role:'logo',assetId:logo.id,x,y:y+25,width,height});
    y+=175;
  }
  for(const font of fonts){
    add({text:font.id+' — '+(font.style??font.name),y});y+=38;
    add({fontId:font.id,text:'Скидка 25% на покупки',fontSize:56,height:75,y});y+=100;
  }
  const v:Variant={id:'identity',name:'Original identity specimens',rationale:'Resource comparison only, not a layout reference or brand approval.',
    width:1200,height:Math.max(200,y),background:'#FFFFFF',sourceIds:[],layers};
  const output=path.join(directory,'references','identity-sheet');
  await renderVariant(directory,v,resources,output);
  return {id:'identity-specimens',kind:'specimen',file:'references/identity-sheet.png',sha256:hash(await readFile(output+'.png'))};
}
