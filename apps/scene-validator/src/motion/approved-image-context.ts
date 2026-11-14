import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {noSymlinkPath,within} from '../files.js';
import {DEFAULT_APPROVED_MOTION_CORPUS_PATH} from './approved-references.js';

export interface ApprovedImageEvidence {referenceId:string;relativePath:string;sha256:string;sourceSha256:string;timecode:[number,number];caption:string;width:number;height:number;}
/** Pin only verified derived contact images. Original videos are never read or sent here. */
export async function pinApprovedMotionImages(entries:ApprovedImageEvidence[],directory:string,corpusPath=DEFAULT_APPROVED_MOTION_CORPUS_PATH){
  const root=path.dirname(path.resolve(corpusPath)),images:string[]=[],evidence:ApprovedImageEvidence[]=[],diagnostics:string[]=[];
  const seen=new Set<string>();
  for(const entry of entries){
    if(images.length===2)break;
    if(seen.has(entry.sha256))continue;
    try{
      if(!/^[a-f0-9]{64}$/.test(entry.sha256)||!entry.relativePath.startsWith('evidence/')||!/^\.(?:png|jpe?g|webp)$/.test(path.extname(entry.relativePath).toLowerCase()))throw Error('Invalid contact-image reference');
      const file=within(root,entry.relativePath);await noSymlinkPath(root,file);
      if((await stat(file)).size>20*1024*1024)throw Error('Contact image exceeds20MB');
      const bytes=await readFile(file),hash=createHash('sha256').update(bytes).digest('hex');
      if(hash!==entry.sha256)throw Error('Contact-image checksum mismatch');
      const imageSignature=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes.subarray(0,3).equals(Buffer.from([255,216,255]))||(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP');
      if(!imageSignature)throw Error('Contact image is not a supported raster');
      await noSymlinkPath(directory,directory);
      const pinned=within(directory,`approved-reference-${hash}${path.extname(entry.relativePath).toLowerCase()}`);
      try{await writeFile(pinned,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await noSymlinkPath(directory,pinned);if(createHash('sha256').update(await readFile(pinned)).digest('hex')!==hash)throw Error('Pinned contact image changed');}
      images.push(pinned);evidence.push({...entry});seen.add(hash);
    }catch(error){diagnostics.push(`${entry.referenceId}: ${(error as Error).message}`);}
  }
  return {images,evidence,diagnostics};
}
