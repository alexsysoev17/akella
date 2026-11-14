"""Build a portable, reviewed page-reference bundle without activating a catalog.

The explicit review plan is the approval boundary. Collection, source grouping,
image filenames and shared text never imply approval or resize relationships.
"""
import argparse
import collections
import copy
import json
import math
import pathlib
import shutil
import tempfile

from brand_library import local, sha, validate, search_text
from reference_asset_pack import build_reference_pack


def read(path):
    return json.loads(pathlib.Path(path).read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))


def bounded_text(value, maximum, label):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('Invalid '+label)
    return value


def review_fields(entry):
    for key, limit in [('title',160), ('scope',300), ('body',600)]:
        bounded_text(entry.get(key), limit, key)
    if entry.get('audience') not in {'consumer','employee','unspecified'}:
        raise ValueError('Explicit audience required')
    if entry.get('usage') not in {'full-style','composition-only','campaign-scoped'}:
        raise ValueError('Explicit reference usage required')
    if not isinstance(entry.get('principles'), list) or any(not isinstance(v,str) for v in entry['principles']):
        raise ValueError('Principles must be an explicit string list')


def geometry_summary(summary):
    """Small exact excerpts; full source metrics remain in hashed evidence files."""
    def fields(item, keys):
        return {key:copy.deepcopy(item[key]) for key in keys if key in item}
    result={'authority':'authored .fig geometry; component/auto-layout resolution partial',
            'counts':summary.get('counts',{}), 'texts':[], 'gradients':[], 'effects':[], 'radii':[]}
    for item in [x for x in summary.get('texts',[]) if x.get('effectiveVisible',True)][:8]:
        value=fields(item,['nodeId','fontName','fontSize','fontVariations','fontWeight','letterSpacing','textTracking','lineHeight','textAlignHorizontal','relativeBounds','derivedGlyphFontSizes'])
        value['characters']=str(item.get('characters',''))[:180]
        if 'relativeBounds' in value:value['relativeBounds'].pop('corners',None)
        result['texts'].append(value)
    for item in summary.get('paints',[]):
        if not item.get('effectiveVisible',True):continue
        for paint in item.get('paints',[]):
            if not str(paint.get('type','')).startswith('GRADIENT') or paint.get('visible') is False:continue
            if len(result['gradients'])<3:
                result['gradients'].append({'nodeId':item['nodeId'],'field':item.get('field'),
                    'paint':fields(paint,['type','opacity','blendMode','stops','gradientStops','transform','gradientTransform'])})
    for key in ['effects','radii']:
        for item in [x for x in summary.get(key,[]) if x.get('effectiveVisible',True)][:5]:
            value=copy.deepcopy(item)
            if key=='effects':value['effects']=value.get('effects',[])[:3]
            result[key].append(value)
    return result


class BundleFiles:
    def __init__(self, output):
        self.output=output
        self.copied={}

    def copy(self, base, filename, expected=None, prefix='files'):
        source=local(base,filename)
        if source in self.copied:
            relative,digest=self.copied[source]
            if expected and expected!=digest:raise ValueError('Source checksum mismatch: '+str(filename))
            return relative,digest
        digest=sha(source.read_bytes())
        if expected and expected!=digest:raise ValueError('Source checksum mismatch: '+str(filename))
        relative=prefix+'/'+digest+source.suffix.lower()
        target=self.output/relative;target.parent.mkdir(parents=True,exist_ok=True)
        if not target.exists():shutil.copyfile(source,target)
        self.copied[source]=(relative,digest)
        return relative,digest


def build_bundle(brand_dir, page_dir, review_plan, out):
    brand_dir,page_dir,review_plan,out=map(lambda p:pathlib.Path(p).resolve(),(brand_dir,page_dir,review_plan,out))
    if out.exists():raise ValueError('Output already exists; choose a new bundle directory')
    catalog=read(local(brand_dir,'catalog.json'));old_source=read(local(brand_dir,catalog['source']))
    old_records=read(local(brand_dir,catalog['records']))
    profile=read(local(brand_dir,catalog.get('authoring','authoring.json')))
    plan=read(review_plan);collected=page_dir/'collected'
    manifest=read(collected/'manifest.json')
    if plan.get('version')!=1:raise ValueError('Unsupported review plan')
    if 'replacePageEvidence' in plan and not isinstance(plan['replacePageEvidence'],bool):raise ValueError('replacePageEvidence must be boolean')
    for key in ['reviewer','date','pageId','sourceFigmaFileKey']:bounded_text(plan.get(key),200,key)
    page_id=plan['pageId']
    if manifest['page']['id']!=page_id:raise ValueError('Review page differs from collected page')
    source_key=manifest.get('source',{}).get('sourceFigmaFileKey')
    if source_key and source_key!=plan['sourceFigmaFileKey']:raise ValueError('Figma file key mismatch')
    replaced_ids=set()
    if plan.get('replacePageEvidence'):
        replaced_ids={r['id'] for r in old_records if r.get('design',{}).get('pageId')==page_id and
                      r['id'].startswith(('ref-','section-','asset-fill-','asset-node-','rule-'))}
        old_records=[r for r in old_records if r['id'] not in replaced_ids]
        profile=copy.deepcopy(profile)
        profile['requiredEvidence']=[key for key in profile.get('requiredEvidence',[]) if key not in replaced_ids]
    refs={r['id']:r for r in read(collected/'references.json')}
    sections={r['id']:r for r in read(collected/'sections.json')}
    page_node_ids=set(read(collected/'raw-node-index.json'))
    bounds={r['id']:r for r in read(page_dir/'source/resolved-bounds-mcp.json')}
    crops={r['id']:r for r in read(page_dir/'crops/manifest.json')}
    images={r['imageHash']:r for r in read(collected/'images.json')}
    selected={};families={};section_plans={}
    for section in plan.get('sections',[]):
        review_fields(section);sid=section['sectionId']
        if sid not in sections or sid not in page_node_ids:raise ValueError('Unknown page section '+sid)
        if sid in section_plans:raise ValueError('Duplicate section review')
        members=section.get('inspectedNodeIds',[])
        if not isinstance(members,list) or len(members)!=len(set(members)):raise ValueError('Invalid inspected node IDs')
        overrides=section.get('overrides',{})
        if not set(overrides)<=set(members):raise ValueError('Override targets an uninspected node')
        for node_id in members:
            if node_id not in refs or refs[node_id].get('sectionId')!=sid or node_id not in page_node_ids:
                raise ValueError('Inspected reference is outside the specified page/section: '+node_id)
            if node_id in selected:raise ValueError('Duplicate inspected reference '+node_id)
            override=overrides.get(node_id,{})
            if override and (override.get('polarity') not in {'negative','unknown'} or not override.get('reason')):
                raise ValueError('Override requires negative/unknown polarity and a reason')
            selected[node_id]=(section,override)
        for family in section.get('families',[]):
            bounded_text(family.get('id'),200,'family ID')
            for node_id in family['nodeIds']:
                if node_id not in members or node_id in families:raise ValueError('Family must contain unique inspected nodes')
                families[node_id]=family['id']
        section_plans[sid]=section
    for item in plan.get('loose',[]):
        review_fields(item);node_id=item['nodeId']
        if node_id not in refs or refs[node_id].get('sectionId') or node_id not in page_node_ids:
            raise ValueError('Loose reference is not a loose member of this page: '+node_id)
        if node_id in selected:raise ValueError('Duplicate inspected reference '+node_id)
        if item.get('polarity','positive') not in {'positive','negative','unknown'}:raise ValueError('Invalid loose polarity')
        selected[node_id]=(item,{'polarity':item.get('polarity','positive'),'reason':item.get('reason','')})
    campaigns={};campaign_ids=set()
    for campaign in plan.get('campaigns',[]):
        campaign_id=bounded_text(campaign.get('id'),200,'campaign ID')
        if campaign_id in campaign_ids:raise ValueError('Duplicate campaign ID')
        campaign_ids.add(campaign_id)
        members=campaign.get('nodeIds')
        if not isinstance(members,list) or not members:raise ValueError('Campaign needs inspected node IDs')
        for node_id in members:
            if node_id not in selected or node_id in campaigns:raise ValueError('Campaign must contain unique inspected nodes')
            campaigns[node_id]=campaign_id
    pack_plans={}
    for pack in plan.get('referencePacks',[]):
        node_id=pack.get('nodeId')
        if node_id not in selected or node_id in pack_plans:raise ValueError('Reference pack needs a unique inspected reference')
        pack_plans[node_id]=pack
    rule_plans={}
    for item in plan.get('rules',[]):
        node_id=item['nodeId']
        if node_id not in page_node_ids or node_id in rule_plans:raise ValueError('Unknown or duplicate rule source node')
        for key,limit in [('title',160),('body',600),('scope',300)]:bounded_text(item.get(key),limit,'rule '+key)
        if item.get('authority') not in {'explicit','observed','inferred'} or item.get('polarity') not in {'positive','negative','mixed','neutral','unknown'}:
            raise ValueError('Rule authority and polarity must be explicit')
        if not isinstance(item.get('links',[]),list) or any(not isinstance(value,str) for value in item.get('links',[])):
            raise ValueError('Invalid rule links')
        rule_plans[node_id]=item
    required_rule_nodes=plan.get('requiredRuleNodeIds',[])
    if not isinstance(required_rule_nodes,list) or not set(required_rule_nodes)<=set(rule_plans):raise ValueError('Required rule is not explicitly reviewed')
    if not selected and not plan.get('assets') and not plan.get('derivedAssets') and not rule_plans:raise ValueError('Review plan does not inspect anything')

    out.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out.parent,prefix='.reference-bundle-') as temporary:
        stage=pathlib.Path(temporary)/'bundle';stage.mkdir();files=BundleFiles(stage)
        source={**old_source,'nodeIds':sorted(set(old_source['nodeIds'])|page_node_ids),
            'referencePage':{'id':page_id,'name':manifest['page'].get('name'),'sourceFigmaFileKey':plan['sourceFigmaFileKey']},
            'referenceProvenance':{'archive':manifest.get('source',{}),'collectionCounts':manifest.get('counts',{}),
                'geometryLimitations':manifest.get('limits',[]),'reviewer':plan['reviewer'],'reviewDate':plan['date'],
                'reviewCertification':'assistant source-grounded review, not user or brand-owner certification',
                'priorCatalogSnapshot':catalog.get('snapshot'),'reviewPlanSha256':sha(review_plan.read_bytes()),
                'explicitPageReplacement':{'enabled':bool(plan.get('replacePageEvidence')),'recordIds':sorted(replaced_ids)},
                'resolvedBoundsSha256':sha((page_dir/'source/resolved-bounds-mcp.json').read_bytes())}}
        write(stage/'source.json',source)
        review_file,review_hash=files.copy(review_plan.parent,review_plan.name,prefix='page')
        bound_file,bound_hash=files.copy(page_dir,'source/resolved-bounds-mcp.json',prefix='page')
        files.copy(collected,'manifest.json',prefix='page')
        records=copy.deepcopy(old_records)
        for record in records:
            validate(record,old_source,brand_dir)
            for e in record['evidence']:
                for key in ['file','image']:
                    if key in e:e[key],e[key+'Sha256']=files.copy(brand_dir,e[key],e.get(key+'Sha256'),'legacy')
            for key in ['media','geometry']:
                if record.get(key):record[key]['file'],record[key]['sha256']=files.copy(brand_dir,record[key]['file'],record[key]['sha256'],'legacy')
        resources={}
        for resource in catalog.get('resources',[])+profile.get('resources',[]):
            resource=copy.deepcopy(resource)
            resource['file'],resource['sha256']=files.copy(brand_dir,resource['file'],resource['sha256'],'legacy')
            if resource['id'] in resources and resources[resource['id']]!=resource:raise ValueError('Conflicting legacy resource')
            resources[resource['id']]=resource
        profile=copy.deepcopy(profile)
        profile['resources']=[resources[r['id']] for r in profile['resources']]
        profile.update(referencePageIds=[page_id],referenceAudience='consumer')
        if 'authoringMode' in plan:
            if plan['authoringMode'] not in {'reference-adaptation','free-composition'}:raise ValueError('Invalid authoring mode')
            profile['authoringMode']=plan['authoringMode']
        provenance={'by':plan['reviewer'],'date':plan['date'],'method':'explicit visual review plan',
                    'certification':'assistant analysis; not user/brand-owner approval'}
        new_records=[];downgraded=[]
        def evidence(node_id):
            return [{'nodeId':node_id,'file':review_file,'fileSha256':review_hash,
                     'url':'https://www.figma.com/design/'+plan['sourceFigmaFileKey']+'/?node-id='+node_id.replace(':','-')},
                    {'nodeId':node_id,'file':bound_file,'fileSha256':bound_hash}]
        for node_id,(entry,override) in selected.items():
            ref=refs[node_id];crop=crops.get(node_id,{});resolved=bounds.get(node_id,{})
            if not crop.get('file') or not resolved.get('visible',True):raise ValueError('Inspected reference has no visible crop: '+node_id)
            box=resolved.get('box',{})
            if any(not isinstance(box.get(k),(int,float)) or not math.isfinite(box[k]) or box[k]<=0 for k in ['width','height']):
                raise ValueError('Missing resolved format: '+node_id)
            image_file,image_hash=files.copy(page_dir/'crops',crop['file'],crop['sha256'],'page')
            geometry_file,geometry_hash=files.copy(collected,ref['geometry']['file'],ref['geometry']['sha256'],'page')
            summary_file,summary_hash=files.copy(collected,ref['summaryFile']['file'],ref['summaryFile']['sha256'],'page')
            summary=read(stage/summary_file)
            polarity=override.get('polarity','positive');reason=override.get('reason','')
            if (crop.get('lowOpacity') or resolved.get('opacity',1)<.75) and polarity=='positive':
                polarity='unknown';reason='Low-opacity source crop; full visual style is not reliable';downgraded.append(node_id)
            annotation=sections.get(ref.get('sectionId'),{}).get('annotation','')
            copy_excerpt=' / '.join(str(t.get('characters','')).replace('\n',' ')[:100] for t in summary.get('texts',[])[:2])
            body=entry['body']+f" Размер Figma: {box['width']:g}×{box['height']:g}."+((' Текст примера: '+copy_excerpt) if copy_excerpt else '')
            if reason:body+=' Оценка источника: '+reason
            record={'id':'ref-'+node_id,'kind':'example','title':(entry['title']+' — '+ref.get('name',node_id))[:160],
                'body':body,'status':'reviewed','authority':'observed','polarity':polarity,'scope':entry['scope'],
                'review':{**provenance,'sourceNodeId':node_id,'polarityReason':reason},'links':[],
                'evidence':evidence(node_id)+[{'nodeId':node_id,'file':summary_file,'fileSha256':summary_hash,'image':image_file,'imageSha256':image_hash}],
                'geometry':{'file':geometry_file,'sha256':geometry_hash},
                'design':{'pageId':page_id,'sectionId':ref.get('sectionId') or '', 'annotation':annotation,
                    'familyId':families.get(node_id,'ref-'+node_id),'audience':entry['audience'],'usage':entry['usage'],'role':'advertisement',
                    'format':{'width':box['width'],'height':box['height'],'ratio':box['width']/box['height'],'authority':'Figma MCP absoluteBoundingBox'},
                    'geometrySummary':geometry_summary(summary),'principles':entry['principles'],
                    'resizeLinks':[],'sourceCrop':{'opacity':resolved.get('opacity',1),'lowOpacity':crop.get('lowOpacity',False),'pixelSize':{'width':crop.get('width'),'height':crop.get('height')}}}}
            if node_id in campaigns:record['design']['campaignId']=campaigns[node_id]
            new_records.append(record)
        reference_records={r['id']:r for r in new_records}
        for record in new_records:
            siblings=[r['id'] for r in new_records if r['id']!=record['id'] and r['design']['familyId']==record['design']['familyId']]
            sid=record['design']['sectionId']
            warnings=[r['id'] for r in new_records if r['id']!=record['id'] and r['polarity']=='negative' and sid and
                      r['design']['sectionId']==sid and r['design']['audience']==record['design']['audience']][:2]
            record['links']=list(dict.fromkeys(siblings+(['section-'+sid] if sid in section_plans else [])+warnings))
            record['design']['resizeLinks']=siblings
        for sid,entry in section_plans.items():
            members=['ref-'+node_id for node_id in entry['inspectedNodeIds']]
            if not members:continue
            polarities={reference_records[r]['polarity'] for r in members}
            new_records.append({'id':'section-'+sid,'kind':'composition','title':entry['title'],'body':entry['body'],
                'status':'reviewed','authority':'observed','polarity':'positive' if polarities=={'positive'} else 'mixed',
                'scope':entry['scope'],'review':provenance,'evidence':evidence(sid),'links':members,
                'design':{'pageId':page_id,'sectionId':sid,'annotation':sections[sid].get('annotation',''),
                    'audience':entry['audience'],'usage':entry['usage'],'role':'composition-study','principles':entry['principles'],
                    'grouping':'source section; only explicit families establish resize relationships'}})
        for item in plan.get('assets',[]):
            image=images.get(item['hash']);node_id=item['sourceNodeId']
            if not image or node_id not in page_node_ids:raise ValueError('Asset is not in the selected page')
            if node_id not in image.get('usedByNodeIds',[]) and item['hash'] not in refs.get(node_id,{}).get('imageHashes',[]):
                raise ValueError('Asset source node does not use the original image')
            original=local(collected,image['file']);given=local(page_dir,item['file'])
            if original!=given:raise ValueError('Asset must point to the collected original image')
            media_file,media_hash=files.copy(collected,image['file'],image['sha256'],'assets')
            polarity=item.get('polarity','positive')
            if polarity not in {'positive','negative','unknown'}:raise ValueError('Invalid asset polarity')
            bounded_text(item['title'],160,'asset title');bounded_text(item['body'],600,'asset body')
            new_records.append({'id':'asset-fill-'+item['hash'],'kind':'asset','title':item['title'],'body':item['body'],
                'tags':item.get('tags',[]),'scope':item['scope'],'status':'reviewed','authority':'observed','polarity':polarity,
                'review':provenance,'links':[],'evidence':evidence(node_id)+[{'nodeId':node_id,'image':media_file,'imageSha256':media_hash}],
                'media':{'file':media_file,'sha256':media_hash,'width':image['width'],'height':image['height'],
                    'hasTransparency':image.get('hasTransparency'),'originalImageHash':item['hash']},
                'design':{'pageId':page_id,'role':'asset','style':item['style'],'use':item['use'],'source':'verified original image-fill bytes'}})
        for item in plan.get('derivedAssets',[]):
            node_id=item['sourceNodeId']
            if node_id not in page_node_ids or item.get('id')!='asset-node-'+node_id:raise ValueError('Derived asset needs a page source node and asset-node ID')
            for key,limit in [('title',160),('body',600),('scope',300),('method',200)]:bounded_text(item.get(key),limit,'derived asset '+key)
            if item.get('polarity','positive') not in {'positive','negative','unknown'}:raise ValueError('Invalid derived asset polarity')
            media_file,media_hash=files.copy(page_dir,item['file'],item['sha256'],'assets')
            if pathlib.Path(media_file).suffix.lower() not in {'.png','.jpg','.jpeg','.webp'}:raise ValueError('Derived asset needs a raster resource; SVG may be retained as source evidence')
            from PIL import Image
            with Image.open(stage/media_file) as image:
                width,height=image.size;transparent='A' in image.getbands() and image.getchannel('A').getextrema()[0]<255
            if (item['width'],item['height'])!=(width,height):raise ValueError('Derived asset dimensions mismatch')
            source_files=[]
            for source_file in item.get('sourceFiles',[]):
                filename,digest=files.copy(page_dir,source_file['file'],source_file['sha256'],'page')
                source_files.append({'nodeId':node_id,'file':filename,'fileSha256':digest})
            new_records.append({'id':item['id'],'kind':'asset','title':item['title'],'body':item['body'],'tags':item.get('tags',[]),
                'scope':item['scope'],'status':'reviewed','authority':'observed','polarity':item.get('polarity','positive'),'review':provenance,'links':[],
                'evidence':evidence(node_id)+source_files+[{'nodeId':node_id,'image':media_file,'imageSha256':media_hash}],
                'media':{'file':media_file,'sha256':media_hash,'width':width,'height':height,'hasTransparency':transparent,
                    'derivation':{'method':item['method'],'sourceNodeId':node_id,'bounds':item.get('exportBounds'),'type':'reviewed-node-export'}},
                'design':{'pageId':page_id,'role':'asset','style':item['style'],'use':item['use'],'source':'reviewed Figma node export; not original image-fill bytes'}})
        if pack_plans:
            raw_nodes=read(collected/'raw-nodes.json')['nodes']
            resolved_packs={}
            if plan.get('resolvedLayersFile'):
                resolved_file,resolved_hash=files.copy(page_dir,plan['resolvedLayersFile'],prefix='page')
                for group in read(stage/resolved_file):
                    if group['id'] not in refs:raise ValueError('Resolved layer group outside collected page')
                    resolved_packs[group['id']]={row['id']:row for row in group['rows']}
            asset_records={r['id']:r for r in new_records if r['kind']=='asset'}
            for node_id,pack in pack_plans.items():
                record=reference_records['ref-'+node_id];ref=refs[node_id]
                geometry=read(local(collected,ref['geometry']['file']));summary=read(local(collected,ref['summaryFile']['file']))
                record['design']['referencePack']=build_reference_pack(pack,record,geometry,summary,images,asset_records,raw_nodes,resolved_packs.get(node_id))
                if node_id in resolved_packs:
                    record['evidence'].append({'nodeId':node_id,'file':resolved_file,'fileSha256':resolved_hash})
                record['links']=list(dict.fromkeys(record['links']+[u['assetId'] for u in record['design']['referencePack']['assetUses']]))
        generated_ids={r['id'] for r in new_records}|{'rule-'+node_id for node_id in rule_plans}
        old_ids={r['id'] for r in old_records}
        def resolve_rule_link(value):
            if value in generated_ids or value in old_ids:return value
            candidates=[prefix+value for prefix in ['ref-','section-','rule-'] if prefix+value in generated_ids]
            if len(candidates)!=1:raise ValueError('Rule link is missing or ambiguous: '+value)
            return candidates[0]
        for node_id,item in rule_plans.items():
            new_records.append({'id':'rule-'+node_id,'kind':'rule','title':item['title'],'body':item['body'],
                'status':'reviewed','authority':item['authority'],'polarity':item['polarity'],'scope':item['scope'],
                'review':provenance,'evidence':evidence(node_id),'links':[resolve_rule_link(value) for value in item.get('links',[])],
                'mandatory':node_id in required_rule_nodes,'design':{'pageId':page_id,'role':'source-annotation'}})
        profile['requiredEvidence']=list(dict.fromkeys(profile.get('requiredEvidence',[])+['rule-'+node_id for node_id in required_rule_nodes]))
        records+=new_records
        ids={r['id'] for r in records}
        if len(ids)!=len(records):raise ValueError('Record ID collision with prior snapshot')
        for record in records:
            validate(record,source,stage);search_text(record)
            missing=[key for key in record['links'] if key not in ids]
            if missing:raise ValueError('Broken evidence link'+(' after explicit page replacement' if replaced_ids else '')+': '+record['id']+' -> '+', '.join(missing))
        if not set(profile.get('requiredEvidence',[]))<=ids:raise ValueError('Required legacy evidence missing')
        coverage={**catalog.get('coverage',{}),'referencePage':{'pageId':page_id,'name':manifest['page'].get('name'),
            'collected':manifest.get('counts',{}),'explicitlyInspectedReferences':len(selected),'reviewedSections':len(section_plans),
            'referencePolarities':dict(collections.Counter(r['polarity'] for r in reference_records.values())),
            'referenceAudiences':dict(collections.Counter(r['design']['audience'] for r in reference_records.values())),
            'lowOpacityDowngraded':downgraded,'explicitFamilies':len(set(families.values())),
            'explicitCampaigns':len(campaign_ids),
            'reviewedReferencePacks':len(pack_plans),
            'reviewedOriginalAssets':len(plan.get('assets',[])),'unreviewedReferences':len(refs)-len(selected),
            'reviewedDerivedAssets':len(plan.get('derivedAssets',[])),
            'reviewedSourceRules':len(rule_plans),'requiredSourceRules':len(set(required_rule_nodes)),
            'replacedPageRecords':len(replaced_ids),
            'review':'Assistant visual review; not user or brand-owner certification',
            'geometry':'Resolved MCP reference bounds; full authored subtree retained; component/auto-layout resolution partial'},
            'legacyRecords':len(old_records),'totalRecords':len(records)}
        for filename,value in [('records.json',records),('coverage.json',coverage),('resources.json',list(resources.values())),('authoring.json',profile)]:write(stage/filename,value)
        shutil.move(str(stage),str(out))
    return {'output':str(out),'records':len(records),'newRecords':len(new_records),'references':len(selected),'coverage':coverage['referencePage']}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--brand-dir',required=True);parser.add_argument('--page-dir',required=True)
    parser.add_argument('--review-plan',required=True);parser.add_argument('--out',required=True);args=parser.parse_args()
    print(json.dumps(build_bundle(args.brand_dir,args.page_dir,args.review_plan,args.out),ensure_ascii=False))
