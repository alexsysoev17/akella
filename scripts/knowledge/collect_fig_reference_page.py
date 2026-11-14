"""Collect authored references from ONE explicitly selected local Figma page.

This is evidence acquisition, not automatic visual review or a Figma renderer.
Only selected-page nodes and image fills are exported. Referenced binary geometry
blobs are retained without resolving components, variables, masks or text shaping.
"""
import argparse
import collections
import functools
import hashlib
import io
import json
import math
import pathlib
import re
import zipfile
from PIL import Image
from normalize_fig_geometry import normalize

SCHEMA='fig-reference-page/1'
IDENTITY=(1,0,0,0,1,0)
CONTAINERS={'FRAME','INSTANCE','SYMBOL','COMPONENT','COMPONENT_SET'}
LIMITS=[
    'Authored geometry and derived source fields are retained, not re-rendered or guaranteed to equal resolved Figma output.',
    'Components, instance overrides and variable aliases are NOT resolved. Out-of-page component definitions are not imported.',
    'Absolute matrices compose authored transforms only. Auto-layout/instance placement can require Figma layout resolution; these rectangles must not be mistaken for verified rendered positions.',
    'Bounds are transformed local rectangles before masks, stroke/effect expansion and clipping; masks and paint transforms remain in source fields.',
    'Section membership is source grouping, not automatic proof that every member shares one creative. Suggested subfamilies require visual review.',
    'Fonts are identified by authored metadata; this collector does not supply font binaries.',
    'All collected evidence and image bytes remain unreviewed; source numbers are not universal brand tokens.',
]


def guid(value):
    return f"{value['sessionID']}:{value['localID']}" if isinstance(value,dict) and 'sessionID' in value and 'localID' in value else None


def digest_file(path):
    h=hashlib.sha256()
    with pathlib.Path(path).open('rb') as stream:
        for chunk in iter(lambda:stream.read(4*1024*1024),b''):h.update(chunk)
    return h.hexdigest()


def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,separators=(',',':')))
    return {'file':str(path),'sha256':digest_file(path),'bytes':path.stat().st_size}


def matrix(value):
    if not value:return IDENTITY
    result=tuple(value.get(k,default) for k,default in zip(['m00','m01','m02','m10','m11','m12'],IDENTITY))
    if any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in result):raise ValueError('Invalid source transform')
    return result


def multiply(a,b):
    return (a[0]*b[0]+a[1]*b[3],a[0]*b[1]+a[1]*b[4],a[0]*b[2]+a[1]*b[5]+a[2],
            a[3]*b[0]+a[4]*b[3],a[3]*b[1]+a[4]*b[4],a[3]*b[2]+a[4]*b[5]+a[5])


def inverse(a):
    d=a[0]*a[4]-a[1]*a[3]
    if abs(d)<1e-12:return None
    return (a[4]/d,-a[1]/d,(a[1]*a[5]-a[4]*a[2])/d,-a[3]/d,a[0]/d,(a[3]*a[2]-a[0]*a[5])/d)


def bounds(size,transform):
    w,h=(size or {}).get('x',0),(size or {}).get('y',0)
    if transform is None or any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in (w,h)):return None
    corners=[(transform[0]*x+transform[1]*y+transform[2],transform[3]*x+transform[4]*y+transform[5]) for x,y in [(0,0),(w,0),(w,h),(0,h)]]
    xs,ys=zip(*corners)
    return {'x':min(xs),'y':min(ys),'width':max(xs)-min(xs),'height':max(ys)-min(ys),'corners':[list(p) for p in corners]}


def walk(value,path=()):
    if isinstance(value,dict):
        yield path,value
        for key,child in value.items():yield from walk(child,path+(key,))
    elif isinstance(value,list):
        for index,child in enumerate(value):yield from walk(child,path+(index,))


def image_hash(value):
    if isinstance(value,str) and re.fullmatch(r'[0-9a-f]{40}',value):return value
    if isinstance(value,dict) and set(value)=={str(i) for i in range(20)}:value=[value[str(i)] for i in range(20)]
    if isinstance(value,list) and len(value)==20 and all(isinstance(v,int) and 0<=v<=255 for v in value):return bytes(value).hex()
    return None


def paint_images(raw):
    for location,value in walk(raw):
        if value.get('type')=='IMAGE':
            key=image_hash(value.get('image',{}).get('hash'))
            if key:yield key,{'propertyPath':list(location),'paintVisible':value.get('visible',True),'paintOpacity':value.get('opacity',1),'imageScaleMode':value.get('imageScaleMode'),'imageTransform':value.get('transform'),'imageRotation':value.get('rotation'),'imageScale':value.get('scale')}


def source_blobs(raw):
    for _,value in walk(raw):
        for key,item in value.items():
            if key in {'commandsBlob','vectorNetworkBlob'} and isinstance(item,int):yield item


def text_content(raw):
    return raw.get('textData',{}).get('characters','')


def clean_copy(value):
    return re.sub(r'\s+',' ',value).strip().lower()


def suggested_groups(members):
    """Exact shared copy/asset signatures only; never merge a section by common logo."""
    groups=[]
    for method in ['shared-copy-and-assets','shared-copy']:
        buckets=collections.defaultdict(list)
        for member in members:
            texts=sorted(set(clean_copy(t['characters']) for t in member['summary']['texts'] if len(clean_copy(t['characters']))>=12))
            if not texts:continue
            signature=[texts,sorted(member['imageHashes'])] if method=='shared-copy-and-assets' else texts
            key=hashlib.sha256(json.dumps(signature,ensure_ascii=False).encode()).hexdigest()[:16]
            buckets[key].append(member)
        for key,items in buckets.items():
            if len(items)<2:continue
            groups.append({'candidateId':method+'-'+key,'basis':method,'memberIds':[r['id'] for r in items],
                           'formats':sorted({f"{r['width']}x{r['height']}" for r in items}),
                           'status':'candidate-needs-visual-review','doesNotAssertSameCreative':True})
    return groups


def collect(decoded_path,archive_path,page_id,output,geometry_path=None,file_key=None):
    if not re.fullmatch(r'\d+:\d+',page_id):raise ValueError('Explicit valid page ID required')
    if file_key is not None and (not isinstance(file_key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}',file_key)):raise ValueError('Invalid explicit Figma file key')
    decoded_path=pathlib.Path(decoded_path);archive_path=pathlib.Path(archive_path);output=pathlib.Path(output)
    document=json.loads(decoded_path.read_text())
    raw_by={guid(n.get('guid')):n for n in document['nodeChanges']}
    if len(raw_by)!=len(document['nodeChanges']) or any(n.get('phase')!='CREATED' for n in raw_by.values()):raise ValueError('Only complete unique-node snapshots supported')
    if raw_by.get(page_id,{}).get('type')!='CANVAS':raise ValueError('Missing selected page')
    if geometry_path:
        normalized=json.loads(pathlib.Path(geometry_path).read_text())
        if normalized.get('pages')!=[page_id]:raise ValueError('Geometry must contain only the selected page')
    else:normalized=normalize(document,[page_id])
    selected={n['id']:n for n in normalized['nodes']}
    if page_id not in selected or any(n.get('pageId')!=page_id for n in selected.values()):raise ValueError('Invalid scoped geometry')
    children=collections.defaultdict(list)
    for index,node in enumerate(document['nodeChanges']):
        key=guid(node['guid'])
        if key in selected:
            selected[key]['rawSourceIndex']=index
            children[guid(node.get('parentIndex',{}).get('guid'))].append(key)
    for values in children.values():values.sort(key=lambda key:(selected[key].get('sourcePosition') or '',selected[key]['rawSourceIndex']))
    @functools.lru_cache(None)
    def ancestry(key):
        if key==page_id:return (page_id,)
        parent=guid(raw_by[key].get('parentIndex',{}).get('guid'))
        if parent not in selected:raise ValueError('Selected node has outside-page parent '+key)
        return ancestry(parent)+(key,)
    @functools.lru_cache(None)
    def absolute(key):
        local=matrix(raw_by[key].get('transform'))
        if key==page_id:return local
        return multiply(absolute(ancestry(key)[-2]),local)
    @functools.lru_cache(None)
    def subtree(key):
        return (key,)+tuple(child for direct in children.get(key,[]) for child in subtree(direct))

    output.mkdir(parents=True,exist_ok=True)
    selected_ids=list(subtree(page_id));raw_index={key:i for i,key in enumerate(selected_ids)}
    hashes_by_node={};image_uses=collections.defaultdict(list);blob_ids=set();unresolved=[]
    for key in selected_ids:
        raw=raw_by[key];ancestry(key);hashes_by_node[key]=set()
        for image_key,info in paint_images(raw):
            hashes_by_node[key].add(image_key);image_uses[image_key].append({'nodeId':key,'effectiveVisible':selected[key]['effectiveVisible'],**info})
        blob_ids.update(source_blobs(raw))
        symbol=raw.get('symbolData') or {}
        if raw.get('type')=='INSTANCE':
            symbol_id=guid(symbol.get('symbolID'))
            unresolved.append({'nodeId':key,'componentId':symbol_id,'componentDefinitionInSelectedPage':symbol_id in selected if symbol_id else False,
                'componentDefinitionPresentInSource':symbol_id in raw_by if symbol_id else False,'overrideCount':len(symbol.get('symbolOverrides',[])),
                'hasDerivedSymbolData':bool(raw.get('derivedSymbolData')),'resolution':'not-resolved'})

    artifacts={}
    for filename,value in [('raw-nodes.json',{'schema':SCHEMA,'pageId':page_id,'nodes':[raw_by[key] for key in selected_ids]}),
                           ('raw-node-index.json',raw_index),('geometry.json',normalized)]:
        info=write_json(output/filename,value);info['file']=filename;artifacts[filename]=info
    blobs=document.get('blobs',[]);missing_blobs=sorted(key for key in blob_ids if not 0<=key<len(blobs))
    info=write_json(output/'blobs.json',{'originalBlobIndices':{str(key):blobs[key] for key in sorted(blob_ids) if 0<=key<len(blobs)},'missing':missing_blobs})
    info['file']='blobs.json';artifacts['blobs.json']=info

    resources=[]
    with zipfile.ZipFile(archive_path) as archive:
        entries={i.filename:i for i in archive.infolist()}
        for image_key,uses in sorted(image_uses.items()):
            record={'imageHash':image_key,'status':'collected-unreviewed','uses':uses,'usedByNodeIds':sorted({x['nodeId'] for x in uses})}
            name='images/'+image_key
            if name not in entries:record['status']='missing';resources.append(record);continue
            if entries[name].file_size>128*1024*1024:record.update(status='not-extracted',reason='source image exceeds128MiB collection limit');resources.append(record);continue
            content=archive.read(name)
            if hashlib.sha1(content).hexdigest()!=image_key:raise ValueError('Source image hash mismatch '+image_key)
            try:
                image=Image.open(io.BytesIO(content));ext={'PNG':'.png','JPEG':'.jpg','WEBP':'.webp','GIF':'.gif'}.get(image.format)
                if not ext:raise ValueError('Unsupported image format '+str(image.format))
                alpha=None
                if image.width*image.height<=80_000_000:
                    alpha=image.convert('RGBA').getchannel('A').getextrema() if image.mode in {'RGBA','LA','P'} else (255,255)
                record.update(width=image.width,height=image.height,format=image.format,mode=image.mode,alphaExtrema=alpha,hasTransparency=alpha[0]<255 if alpha else None)
            except (Image.DecompressionBombError,ValueError,OSError) as error:
                ext='.original';record.update(status='bytes-collected-metadata-unverified',metadataError=str(error))
            filename='images/'+image_key+ext;(output/filename).parent.mkdir(exist_ok=True);(output/filename).write_bytes(content)
            record.update(file=filename,sha256=hashlib.sha256(content).hexdigest(),bytes=len(content),source='original-image-fill')
            resources.append(record)
    write_json(output/'images.json',resources)

    def node_measure(key,reference_id=None):
        raw=raw_by[key];world=absolute(key);ref_inverse=inverse(absolute(reference_id)) if reference_id else None
        rel=multiply(ref_inverse,world) if ref_inverse else (None if reference_id else matrix(raw.get('transform')))
        return {'id':key,'type':raw['type'],'name':raw.get('name',''),'parentId':selected[key]['parentId'],
                'effectiveVisible':selected[key]['effectiveVisible'],'sourcePosition':selected[key].get('sourcePosition'),
                'orderWithinParent':children[selected[key]['parentId']].index(key) if key!=page_id else 0,
                'localSize':raw.get('size'),'localTransform':list(matrix(raw.get('transform'))),'absoluteTransform':list(world),
                'boundsAuthority':'authored-transform-rectangle','layoutAncestorIds':[a for a in ancestry(key)[:-1] if raw_by[a].get('stackMode') not in {None,'NONE'}],
                'absoluteBounds':bounds(raw.get('size'),world),'relativeTo':reference_id,'relativeTransform':list(rel) if rel else None,'relativeBounds':bounds(raw.get('size'),rel),
                'rawNodeIndex':raw_index[key]}

    def summary(keys,reference):
        texts=[];paints=[];effects=[];radii=[];layouts=[];variables=[];masks=[];overrides=[]
        for key in keys:
            raw=raw_by[key];measure=node_measure(key,reference)
            if raw['type']=='TEXT':
                text={k:raw[k] for k in ['fontName','fontSize','fontVariations','letterSpacing','textTracking','lineHeight','textAlignHorizontal','textAlignVertical','paragraphSpacing','listSpacing','textCase','textAutoResize','textTruncation','maxLines','leadingTrim'] if k in raw}
                text.update(nodeId=key,characters=text_content(raw),effectiveVisible=selected[key]['effectiveVisible'],relativeBounds=measure['relativeBounds'],relativeTransform=measure['relativeTransform'],styleRuns=raw.get('textData',{}).get('styleOverrideTable'))
                derived=raw.get('derivedTextData',{});text['derivedLayoutSize']=derived.get('layoutSize');text['derivedBaselines']=derived.get('baselines',[])
                text['derivedGlyphFontSizes']=dict(collections.Counter(str(g.get('fontSize')) for g in derived.get('glyphs',[])))
                texts.append(text)
            if raw.get('symbolData',{}).get('symbolOverrides'):
                overrides.append({'nodeId':key,'symbolId':guid(raw['symbolData'].get('symbolID')),
                    'overrides':raw['symbolData']['symbolOverrides'],'resolution':'retained-not-resolved'})
            for field in ['fillPaints','strokePaints']:
                if raw.get(field):paints.append({'nodeId':key,'field':field,'effectiveVisible':selected[key]['effectiveVisible'],'relativeBounds':measure['relativeBounds'],'paints':raw[field]})
            if raw.get('effects'):effects.append({'nodeId':key,'effects':raw['effects'],'blendMode':raw.get('blendMode','NORMAL'),'effectiveVisible':selected[key]['effectiveVisible']})
            corners={k:v for k,v in raw.items() if k in {'cornerRadius','cornerSmoothing','rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius','rectangleBottomLeftCornerRadius','rectangleBottomRightCornerRadius'}}
            if corners:radii.append({'nodeId':key,**corners})
            layout={k:v for k,v in raw.items() if k.startswith('stack') or k in {'minSize','maxSize','horizontalConstraint','verticalConstraint','proportionsConstrained'}}
            if layout:layouts.append({'nodeId':key,**layout})
            if raw.get('mask') or raw.get('frameMaskDisabled') is False:masks.append({'nodeId':key,'mask':raw.get('mask'),'clipsContent':raw.get('frameMaskDisabled') is False})
            refs=[{'propertyPath':list(p),'value':v} for p,v in walk(raw) if v.get('dataType')=='ALIAS']
            if refs:variables.append({'nodeId':key,'aliases':refs})
        return {'nodeCount':len(keys),'visibleNodeCount':sum(selected[k]['effectiveVisible'] for k in keys),'nodeTypes':dict(collections.Counter(raw_by[k]['type'] for k in keys)),
                'texts':texts,'paints':paints,'effects':effects,'radii':radii,'layout':layouts,'masks':masks,'variableAliases':variables,'componentOverrides':overrides,
                'counts':{'texts':len(texts),'paintedNodes':len(paints),'gradients':sum(p.get('type','').startswith('GRADIENT') for n in paints for p in n['paints']),
                          'effectNodes':len(effects),'radiusNodes':len(radii),'variableAliasNodes':len(variables)}}

    sections=[key for key in selected_ids if raw_by[key]['type']=='SECTION']
    members=[];member_by={}
    for key in selected_ids:
        raw=raw_by[key];parent=selected[key]['parentId']
        if raw['type'] not in CONTAINERS or parent not in {page_id,*sections}:continue
        keys=subtree(key);section=parent if parent in sections else None
        measurements=[node_measure(child,key) for child in keys]
        geo={'schema':SCHEMA,'pageId':page_id,'sourceNodeId':key,'sectionId':section,'nodes':measurements,'rawNodeFile':'../raw-nodes.json','limits':LIMITS}
        geometry_file='references/'+key.replace(':','-')+'.geometry.json';write_json(output/geometry_file,geo)
        summ=summary(keys,key);summary_file='references/'+key.replace(':','-')+'.summary.json';write_json(output/summary_file,summ)
        item={**node_measure(key,parent),'sectionId':section,'sectionName':raw_by[section].get('name') if section else None,
              'width':raw.get('size',{}).get('x',0),'height':raw.get('size',{}).get('y',0),'imageHashes':sorted(set().union(*(hashes_by_node[k] for k in keys))),
              'geometry':{'file':geometry_file,'sha256':digest_file(output/geometry_file),'nodeCount':len(keys)},
              'summaryFile':{'file':summary_file,'sha256':digest_file(output/summary_file)},'summary':summ,'status':'collected-unreviewed'}
        members.append(item);member_by[key]=item
    notes=[]
    for key in selected_ids:
        if raw_by[key]['type']=='TEXT' and not any(x in member_by for x in ancestry(key)[:-1]):
            section=next((x for x in reversed(ancestry(key)[:-1]) if x in sections),None)
            notes.append({**node_measure(key,section or page_id),'sectionId':section,'characters':text_content(raw_by[key]),'interpretation':'source note or loose copy; not automatically a design rule'})
    section_entries=[]
    for key in sections:
        direct=[member_by[child] for child in children.get(key,[]) if child in member_by]
        section_entries.append({**node_measure(key,page_id),'annotation':raw_by[key].get('name',''),'children':[node_measure(child,key) for child in children.get(key,[])],
            'memberIds':[r['id'] for r in direct],'externalTextIds':[r['id'] for r in notes if r['sectionId']==key],
            'grouping':'source section; member relationships require reference review','subfamilyCandidates':suggested_groups(direct) if len(direct)>=12 else []})
    write_json(output/'sections.json',section_entries);write_json(output/'notes.json',notes);write_json(output/'component-resolution.json',unresolved)
    compact_members=[{k:v for k,v in member.items() if k!='summary'} for member in members];write_json(output/'references.json',compact_members)
    counts={'nodes':len(selected_ids),'sections':len(sections),'references':len(members),'sectionReferences':sum(bool(r['sectionId']) for r in members),'unsectionedReferences':sum(not r['sectionId'] for r in members),
            'externalTextNotes':len(notes),'uniqueImageFills':len(resources),'imageUses':sum(len(r['uses']) for r in resources),'imagesCollected':sum('file' in r for r in resources),'missingImages':sum(r['status']=='missing' for r in resources),
            'instancesUnresolved':len(unresolved),'instancesWithOverrides':sum(r['overrideCount']>0 for r in unresolved),'outsidePageComponents':sum(not r['componentDefinitionInSelectedPage'] for r in unresolved),
            'componentDefinitionsMissingFromSource':sum(not r['componentDefinitionPresentInSource'] for r in unresolved),'unknownLocalSizes':sum(any(not isinstance((raw_by[k].get('size') or {}).get(a),(int,float)) for a in ['x','y']) for k in selected_ids),
            'retainedBlobs':len(blob_ids)-len(missing_blobs),'missingBlobs':len(missing_blobs),'referenceTextNodes':sum(len(r['summary']['texts']) for r in members),
            'gradientPaints':sum(r['summary']['counts']['gradients'] for r in members),'effectNodes':sum(r['summary']['counts']['effectNodes'] for r in members)}
    manifest={'schema':SCHEMA,'page':{'id':page_id,'name':raw_by[page_id].get('name')},'status':'collected-unreviewed','source':{'decodedFile':str(decoded_path),'decodedSha256':digest_file(decoded_path),
              'archiveFile':str(archive_path),'archiveSha256':digest_file(archive_path),'archiveDocumentId':document.get('originFileKey'),
              'sourceFigmaFileKey':file_key,'sourceFigmaFileKeyAuthority':'caller-supplied' if file_key else 'unknown'},
              'counts':counts,'artifacts':artifacts,'files':{'references':'references.json','sections':'sections.json','notes':'notes.json','images':'images.json','components':'component-resolution.json'},'limits':LIMITS}
    write_json(output/'manifest.json',manifest);return manifest


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('decoded');parser.add_argument('archive');parser.add_argument('page');parser.add_argument('output');parser.add_argument('--geometry');parser.add_argument('--file-key',help='Explicit Figma URL file key; archive originFileKey can be an unrelated internal document ID');args=parser.parse_args()
    result=collect(args.decoded,args.archive,args.page,args.output,args.geometry,args.file_key)
    print(json.dumps({'page':result['page'],'counts':result['counts'],'status':result['status']},ensure_ascii=False))
