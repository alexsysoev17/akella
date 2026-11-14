"""Explicitly reviewed reference parts and anchors; no visual classification or approval."""
import copy
import math


ASSET_ROLES={'background','material','decor','hero-reference'}
ANCHOR_ROLES={'headline','support','logo','cta','legal','hero','background','decor'}
# preserve: retain the material; replace-with-brief: unavailable historic content;
# match-brief: reusable source product only when its identity/claims match this request.
ASSET_POLICIES={'preserve','replace-with-brief','match-brief'}


def validate_reference_pack(pack, source_node_ids):
    if not isinstance(pack,dict) or pack.get('version')!=1 or pack.get('coordinateSpace')!='normalized-visual-frame':raise ValueError('Invalid reference pack contract')
    if pack.get('sourceNodeId') not in source_node_ids or not isinstance(pack.get('scope'),str) or not pack['scope']:raise ValueError('Invalid reference pack provenance')
    for key in ['assetUses','anchors']:
        entries=pack.get(key)
        if not isinstance(entries,list) or len(entries)>16:raise ValueError('Invalid reference pack '+key)
        for item in entries:
            if not isinstance(item,dict) or item.get('nodeId') not in source_node_ids:raise ValueError('Unknown reference pack node')
            if item.get('role') not in (ASSET_ROLES if key=='assetUses' else ANCHOR_ROLES):raise ValueError('Invalid reference pack role')
            if key=='assetUses' and (not isinstance(item.get('assetId'),str) or item.get('policy') not in ASSET_POLICIES):raise ValueError('Invalid reference pack asset policy')
            transform=item.get('localToNormalized')
            if not isinstance(transform,list) or len(transform)!=6 or any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in transform):raise ValueError('Invalid reference pack transform')


def build_reference_pack(entry, record, geometry, summary, images, asset_records, raw_nodes, resolved_rows=None):
    if record['kind']!='example' or record['polarity']!='positive':
        raise ValueError('Reference pack requires a positive reviewed reference')
    node_id=entry['nodeId'];nodes={n['id']:n for n in geometry['nodes']}
    if node_id not in nodes:raise ValueError('Reference pack root missing')
    if not isinstance(entry.get('scope'),str) or not entry['scope'].strip() or len(entry['scope'])>300:
        raise ValueError('Reference pack needs an explicit bounded scope')
    for key in ['assetUses','anchors']:
        if not isinstance(entry.get(key,[]),list) or len(entry.get(key,[]))>16:raise ValueError('Reference pack '+key+' exceeds 16')
    resolved_rows=resolved_rows or {};root=nodes[node_id];box=resolved_rows.get(node_id,{}).get('bounds',root.get('absoluteBounds',{}))
    if any(not isinstance(box.get(k),(int,float)) or not math.isfinite(box[k]) for k in ['x','y','width','height']) or min(box['width'],box['height'])<=0:
        raise ValueError('Reference pack needs authored visual root bounds')
    limits=['Normalized placement is derived from authored affine geometry; component/auto-layout resolution remains partial.',
            'Asset-use image transforms, nested clips and non-normal blend modes are source facts, not a claim that the banner renderer supports them.']
    resolved=record['design']['format']
    if any(abs(box[k]-resolved[k])>max(1,abs(resolved[k])*.005) for k in ['width','height']):
        limits.append('Authored visual dimensions differ from resolved MCP dimensions; placement requires source review before exact reconstruction.')
    masks={n['nodeId']:n for n in summary.get('masks',[])}
    text_nodes={n['nodeId']:n for n in summary.get('texts',[])}
    order={n['id']:i for i,n in enumerate(geometry['nodes'])}
    def raw(n):
        index=n.get('rawNodeIndex')
        if not isinstance(index,int) or index<0 or index>=len(raw_nodes):raise ValueError('Reference pack raw source unavailable')
        return raw_nodes[index]
    def placement(key):
        n=nodes.get(key)
        if not n or n.get('effectiveVisible') is False:raise ValueError('Reference pack use/anchor outside visible subtree: '+key)
        resolved_node=resolved_rows.get(key,{});t=resolved_node.get('transform',n.get('absoluteTransform'));size=n.get('localSize',{})
        if isinstance(t,list) and len(t)==2 and all(isinstance(row,list) and len(row)==3 for row in t):t=t[0]+t[1]
        if not isinstance(t,list) or len(t)!=6 or any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in t):raise ValueError('Invalid source affine transform')
        if any(not isinstance(size.get(k),(int,float)) or not math.isfinite(size[k]) or size[k]<=0 for k in ['x','y']):raise ValueError('Invalid source local size')
        transform=[t[0]/box['width'],t[1]/box['width'],(t[2]-box['x'])/box['width'],t[3]/box['height'],t[4]/box['height'],(t[5]-box['y'])/box['height']]
        corners=[[transform[0]*x+transform[1]*y+transform[2],transform[3]*x+transform[4]*y+transform[5]] for x,y in [(0,0),(size['x'],0),(size['x'],size['y']),(0,size['y'])]]
        xs,ys=zip(*corners);opacity=1;ancestors=[];current=n;seen=set()
        while current:
            if current['id'] in seen:raise ValueError('Reference pack ancestry cycle')
            seen.add(current['id']);opacity*=raw(current).get('opacity',1)
            mask=masks.get(current['id'])
            if mask and (mask.get('mask') or mask.get('clipsContent')):ancestors.append(current['id'])
            current=nodes.get(current.get('parentId'))
        normalized={'x':min(xs),'y':min(ys),'width':max(xs)-min(xs),'height':max(ys)-min(ys)}
        if resolved_node.get('bounds'):
            rb=resolved_node['bounds'];normalized={'x':(rb['x']-box['x'])/box['width'],'y':(rb['y']-box['y'])/box['height'],'width':rb['width']/box['width'],'height':rb['height']/box['height']}
        return {'nodeId':key,'bounds':normalized,'geometryAuthority':'Figma MCP resolved' if resolved_node else 'authored .fig affine',
                'localSize':{'width':size['x'],'height':size['y']},'localToNormalized':transform,
                'zOrder':order[key],'nodeOpacity':raw(n).get('opacity',1),'effectiveOpacity':opacity,
                'blendMode':raw(n).get('blendMode','NORMAL'),'clipAncestorIds':ancestors,
                **({'layoutAncestorIds':n['layoutAncestorIds']} if n.get('layoutAncestorIds') else {})}
    uses=[];seen=set()
    for item in entry.get('assetUses',[]):
        key=item['nodeId'];image_hash=item.get('imageHash');prop=item.get('propertyPath')
        if item.get('role') not in ASSET_ROLES or item.get('policy') not in ASSET_POLICIES:raise ValueError('Invalid explicit asset role/policy')
        if item.get('assetId'):
            if image_hash or prop:raise ValueError('Derived node use cannot also identify an original image paint')
            asset=asset_records.get(item['assetId'])
            if key==node_id:raise ValueError('A whole reference banner cannot become a standalone material')
            if not asset or asset['polarity']!='positive' or asset.get('design',{}).get('use')=='referenceOnly' or asset.get('media',{}).get('derivation',{}).get('sourceNodeId')!=key:
                raise ValueError('Derived reference use needs a reviewed export of this exact node')
            identity=(key,'node-export')
            if identity in seen:raise ValueError('Duplicate derived node use')
            seen.add(identity);use={**placement(key),'assetId':asset['id'],'role':item['role'],'policy':item['policy'],
                'sourceKind':'reviewed-node-export','preserveOriginalBounds':True,
                'appearanceBaked':True,'renderTransform':'axis-aligned-export-canvas',
                'note':'The node export already includes its own rotation, opacity, paints and effects; do not apply them a second time. Source affine fields remain audit geometry.'}
            if asset['media']['derivation'].get('bounds'):
                rb=asset['media']['derivation']['bounds']
                if any(not isinstance(rb.get(k),(int,float)) or not math.isfinite(rb[k]) for k in ['x','y','width','height']) or min(rb['width'],rb['height'])<=0:raise ValueError('Invalid export bounds')
                use['bounds']={'x':(rb['x']-box['x'])/box['width'],'y':(rb['y']-box['y'])/box['height'],'width':rb['width']/box['width'],'height':rb['height']/box['height']}
                use['exportBoundsAuthority']='explicit reviewed export canvas'
            if item.get('note'):
                if not isinstance(item['note'],str) or len(item['note'])>400:raise ValueError('Asset-use note exceeds 400')
                use['note']+=' '+item['note']
            uses.append(use);continue
        if not isinstance(prop,list) or len(prop)!=2 or prop[0] not in {'fillPaints','strokePaints'} or not isinstance(prop[1],int) or prop[1]<0:raise ValueError('Invalid image propertyPath')
        identity=(key,tuple(prop))
        if identity in seen:raise ValueError('Duplicate image use in reference pack')
        seen.add(identity)
        image=images.get(image_hash);asset=asset_records.get('asset-fill-'+image_hash)
        if not image or not asset or asset['polarity']!='positive' or asset['status']!='reviewed' or asset.get('design',{}).get('use')=='referenceOnly':raise ValueError('Reference pack asset must be explicitly reviewed and reusable: '+str(image_hash))
        match=next((u for u in image.get('uses',[]) if u['nodeId']==key and u.get('propertyPath')==prop),None)
        if not match or match.get('effectiveVisible') is False or match.get('paintVisible') is False or match.get('paintOpacity',1)<=0:raise ValueError('Reference pack image paint is missing or hidden')
        p=placement(key);paint=raw(nodes[key]).get(prop[0],[])
        if prop[1]>=len(paint):raise ValueError('Source paint not found')
        paint=paint[prop[1]]
        resolved_paints=resolved_rows.get(key,{}).get('fills' if prop[0]=='fillPaints' else 'strokes',[])
        resolved_paint=resolved_paints[prop[1]] if prop[1]<len(resolved_paints) else None
        if resolved_paint and resolved_paint.get('imageHash')!=image_hash:raise ValueError('Resolved image paint hash differs from collected source')
        if asset['media']['sha256']!=image['sha256']:raise ValueError('Reference pack original checksum mismatch')
        use={**p,'assetId':asset['id'],'sourceImageHash':image_hash,'propertyPath':prop,'role':item['role'],'policy':item['policy'],
             'paintOpacity':match.get('paintOpacity',1),'paintBlendMode':paint.get('blendMode','NORMAL'),
             'imageScaleMode':match.get('imageScaleMode'),'imageTransform':copy.deepcopy(match.get('imageTransform')),
             'imageRotation':match.get('imageRotation',0),'imageScale':match.get('imageScale',1),
             'preserveOriginalBounds':True}
        if paint.get('paintFilter'):use['imageFilters']=copy.deepcopy(paint['paintFilter'])
        if resolved_paint:
            use.update(imageScaleMode=resolved_paint.get('scaleMode'),imageTransform=copy.deepcopy(resolved_paint.get('imageTransform')),
                       paintOpacity=resolved_paint.get('opacity',1),paintBlendMode=resolved_paint.get('blendMode','NORMAL'),
                       imageFilters=copy.deepcopy(resolved_paint.get('filters',{})))
        if item.get('note'):
            if not isinstance(item['note'],str) or len(item['note'])>400:raise ValueError('Asset-use note exceeds 400')
            use['note']=item['note']
        uses.append(use)
    anchors=[];seen=set()
    for item in entry.get('anchors',[]):
        key=item['nodeId']
        if key in seen or item.get('role') not in ANCHOR_ROLES:raise ValueError('Invalid or duplicate reference anchor')
        seen.add(key);anchor={**placement(key),'role':item['role']}
        if key in text_nodes:
            t=text_nodes[key]
            anchor['textStyle']={k:copy.deepcopy(t[k]) for k in ['fontName','fontSize','letterSpacing','textTracking','lineHeight','textAlignHorizontal','textAlignVertical'] if k in t}
            anchor['sourceText']=t.get('characters','')
        # Exact active non-image paint stack: gradient colors/transforms remain available.
        paints=[p for p in resolved_rows.get(key,{}).get('fills',raw(nodes[key]).get('fillPaints',[])) if p.get('visible',True) and p.get('type')!='IMAGE']
        if len(paints)>8:raise ValueError('Reference anchor paint stack exceeds 8')
        if paints:anchor['fills']=[{k:copy.deepcopy(p[k]) for k in ['type','color','opacity','blendMode','stops','gradientStops','transform','gradientTransform'] if k in p} for p in paints]
        strokes=[p for p in resolved_rows.get(key,{}).get('strokes',raw(nodes[key]).get('strokePaints',[])) if p.get('visible',True) and p.get('type')!='IMAGE']
        if len(strokes)>8:raise ValueError('Reference anchor stroke stack exceeds 8')
        if strokes:
            anchor['strokes']=[{k:copy.deepcopy(p[k]) for k in ['type','color','opacity','blendMode','stops','gradientStops','transform','gradientTransform'] if k in p} for p in strokes]
            anchor['strokeStyle']={k:copy.deepcopy(raw(nodes[key])[k]) for k in ['strokeWeight','strokeAlign','strokeCap','strokeJoin','strokeMiterLimit','dashPattern'] if k in raw(nodes[key])}
        effects=[p for p in resolved_rows.get(key,{}).get('effects',raw(nodes[key]).get('effects',[])) if p.get('visible',True)]
        if effects:anchor['effects']=copy.deepcopy(effects)
        if item.get('note'):
            if not isinstance(item['note'],str) or len(item['note'])>400:raise ValueError('Anchor note exceeds 400')
            anchor['note']=item['note']
        anchors.append(anchor)
    if not uses and not anchors:raise ValueError('Reference pack has no reviewed parts')
    return {'version':1,'scope':entry['scope'],'sourceNodeId':node_id,'sourceGeometrySha256':record['geometry']['sha256'],
            'coordinateSpace':'normalized-visual-frame','sourceSize':{'width':resolved['width'],'height':resolved['height']},
            'coordinateAuthority':'MCP resolved bounds/affines when available; authored fallback is labelled per node. Normalized to visual root bounds; local node sizes from original source.',
            'assetUses':uses,'anchors':anchors,'limits':limits}
