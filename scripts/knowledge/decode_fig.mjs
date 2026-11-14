/** Offline decoder for canvas.fig from a local Figma ZIP. Node 24+ for Zstandard.
 * Uses the schema embedded in the source; does not execute document content.
 * kiwi-schema is an optional ingestion dependency, not part of the app runtime.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const kiwi=require('../../data/knowledge/fig-decoder/package/kiwi.js');
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node decode_fig.mjs canvas.fig decoded.json');
const bytes=fs.readFileSync(input);
if(bytes.length>128*1024*1024||bytes.subarray(0,8).toString()!=='fig-kiwi')throw Error('Invalid/oversized canvas.fig');
const chunks=[];let offset=12;
while(offset<bytes.length){
 if(offset+4>bytes.length)throw Error('Truncated chunk length');
 const length=bytes.readUInt32LE(offset);offset+=4;
 if(length>bytes.length-offset)throw Error('Truncated chunk');
 chunks.push(bytes.subarray(offset,offset+length));offset+=length;
}
if(chunks.length<2)throw Error('Schema and document required');
const schema=kiwi.decodeBinarySchema(zlib.inflateRawSync(chunks[0],{maxOutputLength:2*1024*1024}));
// Kiwi generates decoder functions. Validate every interpolated identifier before
// compilation; values in the decoded document are never evaluated as JavaScript.
const identifier=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
if(schema.package!==null&&!identifier(schema.package))throw Error('Invalid schema package');
for(const definition of schema.definitions){
 if(!identifier(definition.name)||!['STRUCT','MESSAGE','ENUM'].includes(definition.kind))throw Error('Invalid definition');
 for(const field of definition.fields){
  if(!identifier(field.name)||field.type!==null&&!identifier(field.type)||!Number.isInteger(field.value))throw Error('Invalid schema field');
 }
}
const data=chunks[1].readUInt32LE(0)===0xfd2fb528
 ?zlib.zstdDecompressSync(chunks[1],{maxOutputLength:256*1024*1024})
 :zlib.inflateRawSync(chunks[1],{maxOutputLength:256*1024*1024});
const message=kiwi.compileSchema(schema).decodeMessage(data);
fs.writeFileSync(output,JSON.stringify(message,(key,value)=>typeof value==='bigint'?value.toString():value));
console.log(JSON.stringify({version:bytes.readUInt32LE(8),nodeChanges:message.nodeChanges?.length}));
