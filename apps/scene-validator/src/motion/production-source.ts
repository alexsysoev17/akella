import {createHash} from 'node:crypto';
import {z} from 'zod';
export const sourceMappingSchema=z.object({version:z.literal('source-spans/1'),status:z.enum(['EXACT','NORMALIZED','COMPOSITE','AMBIGUOUS','UNRESOLVED']),references:z.array(z.object({clauseId:z.string(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),text:z.string()}).strict()),unmatchedTokens:z.array(z.string())}).strict();
/** Provenance is not an execution permission gate. Original bytes/spans are authoritative. */
export function mapProductionSource(original:string,quote:string):z.infer<typeof sourceMappingSchema>{
 const ref=(start:number,end:number)=>({clauseId:'clause_'+createHash('sha256').update(JSON.stringify([start,end,original.slice(start,end)])).digest('hex').slice(0,20),start,end,text:original.slice(start,end)});
 const exact=original.indexOf(quote);if(quote.trim()&&exact>=0)return {version:'source-spans/1',status:original.indexOf(quote,exact+1)>=0?'AMBIGUOUS':'EXACT',references:[ref(exact,exact+quote.length)],unmatchedTokens:[]};
 const tokens=(s:string)=>[...s.matchAll(/\S+/gu)].map(m=>({text:m[0].normalize('NFC'),start:m.index!,end:m.index!+m[0].length})),source=tokens(original),query=tokens(quote),references:ReturnType<typeof ref>[]=[],unmatchedTokens:string[]=[];let cursor=0,ambiguous=false;
 for(let i=0;i<query.length;){let best=-1,length=0,ties=0;for(let j=cursor;j<source.length;j++){let n=0;while(i+n<query.length&&j+n<source.length&&source[j+n].text===query[i+n].text)n++;if(n>length){best=j;length=n;ties=1;}else if(n&&n===length)ties++;}if(!length){unmatchedTokens.push(query[i++].text);continue;}ambiguous ||= ties>1;references.push(ref(source[best].start,source[best+length-1].end));cursor=best+length;i+=length;}
 return {version:'source-spans/1',status:unmatchedTokens.length||!references.length?'UNRESOLVED':ambiguous?'AMBIGUOUS':references.length>1?'COMPOSITE':'NORMALIZED',references,unmatchedTokens};
}
