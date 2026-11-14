"""Renderer-only SFNT copies align static OS/2 weights with declared CSS faces.

Some fonts use intermediate weights (e.g. 511) which the native font database
classifies as Regular while CSS requests Medium. Glyphs, names and original
resources remain untouched. Variable faces are not normalized.
"""
import hashlib
import pathlib
import struct

WEIGHTS = {'Thin':100,'ExtraLight':200,'Light':300,'Regular':400,'Medium':500,'SemiBold':600,'Bold':700,'ExtraBold':800,'Black':900}

def checksum(data):
    data=bytes(data)+b'\0'*((-len(data))%4)
    return sum(struct.unpack('>'+str(len(data)//4)+'I',data)) & 0xffffffff

def normalized_weight(data, weight):
    if data[:4] not in [b'\0\1\0\0',b'OTTO'] or len(data)<12:return data,False
    count=struct.unpack_from('>H',data,4)[0]
    if len(data)<12+count*16:raise ValueError('Truncated font directory')
    tables={}
    for i in range(count):
        entry=12+i*16;tag,_,offset,size=struct.unpack_from('>4sIII',data,entry)
        if offset+size>len(data):raise ValueError('Truncated font table')
        tables[tag]=(entry,offset,size)
    if b'fvar' in tables or b'OS/2' not in tables or b'head' not in tables:return data,False
    entry,offset,size=tables[b'OS/2'];_,head,headsize=tables[b'head']
    if size<6 or headsize<12:raise ValueError('Invalid font metadata')
    if struct.unpack_from('>H',data,offset+4)[0]==weight:return data,False
    result=bytearray(data)
    struct.pack_into('>H',result,offset+4,weight)
    struct.pack_into('>I',result,entry+4,checksum(result[offset:offset+size]))
    # head's table checksum is defined with checkSumAdjustment set to zero.
    struct.pack_into('>I',result,head+8,0)
    headentry=tables[b'head'][0]
    struct.pack_into('>I',result,headentry+4,checksum(result[head:head+headsize]))
    struct.pack_into('>I',result,head+8,(0xB1B0AFBA-checksum(result)) & 0xffffffff)
    return bytes(result),True

def native_font_files(request, directory):
    used={l['fontId'] for l in request['variant']['layers'] if l['kind']=='text'}
    files=[];changes=[]
    for resource in request['resources']:
        if resource['kind']!='font' or resource['id'] not in used:continue
        source=pathlib.Path(resource['absoluteFile']);weight=WEIGHTS.get(resource.get('style'))
        data=source.read_bytes();derived,changed=normalized_weight(data,weight) if weight else (data,False)
        if changed:
            directory.mkdir(parents=True,exist_ok=True)
            target=directory/(hashlib.sha256(derived).hexdigest()+source.suffix)
            if not target.exists():target.write_bytes(derived)
            files.append(str(target))
            changes.append({'fontId':resource['id'],'cssWeight':weight,'sourceSha256':hashlib.sha256(data).hexdigest(),
                'derivedSha256':hashlib.sha256(derived).hexdigest(),'changed':'OS/2 weight and checksums only; original glyph tables unchanged'})
        else:files.append(str(source))
    return files,changes
