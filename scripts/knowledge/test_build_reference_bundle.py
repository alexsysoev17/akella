"""Independent portable-bundle fixtures; no client files, models or Figma calls."""
import copy
import json
import pathlib
import tempfile
import unittest

import brand_library as library
from build_reference_bundle import build_bundle, geometry_summary, write


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        self.brand=self.root/'brand';self.page=self.root/'page';self.out=self.root/'bundle';self.plan_path=self.root/'review-plan.json'
        self.brand.mkdir();(self.page/'collected/references').mkdir(parents=True);(self.page/'crops').mkdir();(self.page/'source').mkdir()
        source={'nodeIds':['old:1']};write(self.brand/'source.json',source)
        (self.brand/'font.ttf').write_bytes(b'independent font resource')
        self.resource={'id':'font','kind':'font','file':'font.ttf','sha256':library.sha((self.brand/'font.ttf').read_bytes())}
        self.old={'id':'old-rule','kind':'rule','status':'reviewed','authority':'explicit','polarity':'neutral','title':'Original logo',
            'body':'Keep original proportions','scope':'brand','review':{'by':'legacy reviewer'},'links':[],'mandatory':True,
            'evidence':[{'nodeId':'old:1','file':'source.json','fileSha256':library.sha((self.brand/'source.json').read_bytes())}]}
        write(self.brand/'records.json',[self.old]);write(self.brand/'authoring.json',{'version':1,'snapshot':'old','resources':[self.resource],'requiredEvidence':['old-rule']})
        write(self.brand/'catalog.json',{'brand':'fixture','snapshot':'old','source':'source.json','records':'records.json','resources':[self.resource],'coverage':{'legacy':'retained'}})
        self.catalog_before=(self.brand/'catalog.json').read_bytes()
        self.refs=[];self.bounds=[];self.crops=[]
        for node_id in ['a','b','c','negative','dim','uninspected','loose']:
            geometry={'nodes':[{'id':node_id,'width':100,'height':100,'rawField':'preserved'}]}
            summary={'texts':[{'nodeId':node_id+'-text','characters':'Independent claim','fontName':{'family':'Fixture','style':'Bold'},'fontSize':42,
                'textTracking':-1,'lineHeight':{'units':'RAW','value':1.1},'relativeBounds':{'x':24,'y':40,'width':350,'height':60}}],
                'paints':[{'nodeId':node_id,'paints':[{'type':'GRADIENT_LINEAR','stops':[{'position':0,'color':{'r':0}},{'position':1,'color':{'r':1}}],
                    'transform':{'m00':1,'m01':0,'m10':0,'m11':1}}]}],'effects':[{'nodeId':node_id,'effects':[{'type':'DROP_SHADOW','radius':12}]}],
                'radii':[{'nodeId':node_id,'radius':18}],'counts':{'texts':1,'gradients':1}}
            gp=self.page/f'collected/references/{node_id}.geometry.json';sp=self.page/f'collected/references/{node_id}.summary.json'
            write(gp,geometry);write(sp,summary)
            self.refs.append({'id':node_id,'name':'Frame '+node_id,'sectionId':None if node_id=='loose' else 'section',
                'geometry':{'file':str(gp.relative_to(self.page/'collected')),'sha256':library.sha(gp.read_bytes())},
                'summaryFile':{'file':str(sp.relative_to(self.page/'collected')),'sha256':library.sha(sp.read_bytes())},'imageHashes':['opaque-figma-image-id']})
            self.bounds.append({'id':node_id,'box':{'x':100,'y':200,'width':600 if node_id=='b' else 1200,'height':1200 if node_id=='b' else 600},'visible':True,'opacity':.4 if node_id=='dim' else 1})
            image=self.page/f'crops/{node_id}.png';image.write_bytes(('synthetic inspected pixels '+node_id).encode())
            self.crops.append({'id':node_id,'file':image.name,'sha256':library.sha(image.read_bytes()),'width':400,'height':200,'lowOpacity':node_id=='dim'})
        self.nodes=['page','section','image-node']+[r['id'] for r in self.refs]
        write(self.page/'collected/raw-node-index.json',{n:i for i,n in enumerate(self.nodes)})
        write(self.page/'collected/references.json',self.refs)
        write(self.page/'collected/sections.json',[{'id':'section','annotation':'Selected source grouping'}])
        write(self.page/'collected/manifest.json',{'page':{'id':'page','name':'Examples'},'source':{'archiveDocumentId':'lk-internal','sourceFigmaFileKey':'figma-key','archiveSha256':'archive-hash'},'counts':{'references':7,'nodes':len(self.nodes)},'limits':['instances unresolved']})
        self.save_source()
        asset=self.page/'collected/images/original.png';asset.parent.mkdir();asset.write_bytes(b'original image bytes, Figma ID is not a byte SHA-1')
        write(self.page/'collected/images.json',[{'imageHash':'opaque-figma-image-id','usedByNodeIds':['image-node'],'file':'images/original.png',
            'sha256':library.sha(asset.read_bytes()),'width':40,'height':50,'hasTransparency':True}])
        fields={'title':'Fixture composition','scope':'specific campaign','body':'Observed design arrangement','principles':['Large primary claim','Keep the source scope'],
                'audience':'consumer','usage':'campaign-scoped'}
        self.plan={'version':1,'reviewer':'assistant fixture','date':'2026-11-12','pageId':'page','sourceFigmaFileKey':'figma-key',
            'sections':[{**fields,'sectionId':'section','inspectedNodeIds':['a','b','c','negative','dim'],
                'families':[{'id':'explicit-campaign','nodeIds':['a','b']}],'overrides':{'negative':{'polarity':'negative','reason':'Explicit do-not-use annotation'}}}],
            'loose':[{**fields,'nodeId':'loose'}],
            'assets':[{'hash':'opaque-figma-image-id','file':'collected/images/original.png','title':'Original object','body':'Inspected standalone object','tags':['3d'],
                'sourceNodeId':'image-node','scope':'brand','style':'3d','use':'isolated key visual'}]}

    def save_source(self):
        write(self.page/'source/resolved-bounds-mcp.json',self.bounds);write(self.page/'crops/manifest.json',self.crops)

    def build(self):
        write(self.plan_path,self.plan)
        return build_bundle(self.brand,self.page,self.plan_path,self.out)

    def tearDown(self):self.temp.cleanup()

    def add_pack(self):
        geometry={'nodes':[{'id':'a','parentId':'section','localSize':{'x':600,'y':1200},'absoluteTransform':[0,-1,1300,1,0,200],
            'absoluteBounds':{'x':100,'y':200,'width':1200,'height':600},'effectiveVisible':True,'rawNodeIndex':0},
            {'id':'image-node','parentId':'a','localSize':{'x':100,'y':200},'absoluteTransform':[0,-1,1200,1,0,260],
             'effectiveVisible':True,'rawNodeIndex':1}]}
        gp=self.page/'collected/references/a.geometry.json';write(gp,geometry)
        self.refs[0]['geometry']['sha256']=library.sha(gp.read_bytes());write(self.page/'collected/references.json',self.refs)
        paint={'type':'IMAGE','opacity':.8,'visible':True,'blendMode':'NORMAL','paintFilter':{'exposure':.19}}
        write(self.page/'collected/raw-nodes.json',{'nodes':[{'opacity':1,'fillPaints':[]},{'opacity':.7,'fillPaints':[paint],
            'strokePaints':[{'type':'GRADIENT_LINEAR','visible':True,'stops':[{'position':0,'color':{'r':.5}},{'position':1,'color':{'r':1}}]}],
            'strokeWeight':12,'strokeAlign':'CENTER'}]})
        images=json.loads((self.page/'collected/images.json').read_text());images[0]['uses']=[{'nodeId':'image-node','propertyPath':['fillPaints',0],
            'effectiveVisible':True,'paintVisible':True,'paintOpacity':.8,'imageScaleMode':'STRETCH','imageTransform':{'m00':1,'m01':0,'m02':0,'m10':0,'m11':1,'m12':0}}]
        write(self.page/'collected/images.json',images)
        self.plan['referencePacks']=[{'nodeId':'a','scope':'specific visual campaign','assetUses':[{'nodeId':'image-node','imageHash':'opaque-figma-image-id',
            'propertyPath':['fillPaints',0],'role':'material','policy':'preserve'}],'anchors':[{'nodeId':'image-node','role':'decor'}]}]

    def test_reference_pack_preserves_original_uses_and_rotated_visual_axes(self):
        self.add_pack();self.build();records={r['id']:r for r in json.loads((self.out/'records.json').read_text())}
        pack=records['ref-a']['design']['referencePack'];use=pack['assetUses'][0]
        self.assertEqual(pack['sourceSize'],{'width':1200,'height':600});self.assertEqual(pack['coordinateSpace'],'normalized-visual-frame')
        self.assertAlmostEqual(use['bounds']['x'],.75);self.assertAlmostEqual(use['bounds']['y'],.1)
        self.assertAlmostEqual(use['bounds']['width'],1/6);self.assertAlmostEqual(use['bounds']['height'],1/6)
        self.assertEqual(use['imageFilters'],{'exposure':.19});self.assertEqual(use['nodeOpacity'],.7);self.assertEqual(use['paintOpacity'],.8)
        self.assertTrue(use['preserveOriginalBounds']);self.assertIn('asset-fill-opaque-figma-image-id',records['ref-a']['links'])
        self.assertEqual(use['geometryAuthority'],'authored .fig affine');self.assertTrue(pack['limits'])
        self.assertEqual(pack['anchors'][0]['strokes'][0]['type'],'GRADIENT_LINEAR');self.assertEqual(pack['anchors'][0]['strokeStyle']['strokeWeight'],12)

    def test_reference_pack_uses_hashed_resolved_mcp_geometry_when_present(self):
        self.add_pack();self.plan['resolvedLayersFile']='source/resolved-layers.json'
        write(self.page/self.plan['resolvedLayersFile'],[{'id':'a','rows':[
            {'id':'a','bounds':{'x':100,'y':200,'width':1200,'height':600},'transform':[[0,-1,1300],[1,0,200]]},
            {'id':'image-node','bounds':{'x':940,'y':320,'width':200,'height':100},'transform':[[0,-1,1140],[1,0,320]],
             'fills':[{'imageHash':'opaque-figma-image-id','scaleMode':'CROP','opacity':.8,'imageTransform':[[1,0,0],[0,1,0]],'filters':{'exposure':.2}}]}]}])
        self.build();r=next(r for r in json.loads((self.out/'records.json').read_text()) if r['id']=='ref-a');use=r['design']['referencePack']['assetUses'][0]
        self.assertEqual(use['geometryAuthority'],'Figma MCP resolved');self.assertEqual(use['bounds']['x'],.7);self.assertEqual(use['bounds']['y'],.2)
        self.assertEqual(use['imageScaleMode'],'CROP');self.assertEqual(use['imageFilters']['exposure'],.2)
        self.assertEqual(len(r['evidence']),4);self.assertTrue((self.out/r['evidence'][-1]['file']).is_file())

    def test_reference_pack_rejects_unreviewed_hidden_or_foreign_parts(self):
        self.add_pack();original=copy.deepcopy(self.plan)
        for mutate in [lambda:self.plan['referencePacks'][0].update(nodeId='uninspected'),
                       lambda:self.plan['assets'][0].update(polarity='negative'),
                       lambda:self.plan['referencePacks'][0]['assetUses'][0].update(nodeId='b'),
                       lambda:self.plan['referencePacks'][0]['assetUses'][0].update(propertyPath=['fillPaints',1])]:
            self.plan=copy.deepcopy(original);mutate()
            with self.assertRaises(ValueError):self.build()
            self.assertFalse(self.out.exists())
        self.plan=original;images=json.loads((self.page/'collected/images.json').read_text());images[0]['uses'][0]['paintVisible']=False
        write(self.page/'collected/images.json',images)
        with self.assertRaisesRegex(ValueError,'hidden'):self.build()

    def test_derived_node_material_retains_svg_provenance_and_full_export_bounds(self):
        from PIL import Image
        self.add_pack();png=self.page/'source/material.png';svg=self.page/'source/material.svg'
        Image.new('RGBA',(40,60),(255,0,0,128)).save(png);svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"/>')
        self.plan['derivedAssets']=[{'id':'asset-node-image-node','sourceNodeId':'image-node','file':'source/material.png','sha256':library.sha(png.read_bytes()),
            'width':40,'height':60,'title':'Inspected vector material','body':'Source gradient material','scope':'specific campaign','style':'vector gradient','use':'material',
            'method':'Figma isolated SVG export; local rasterization','sourceFiles':[{'file':'source/material.svg','sha256':library.sha(svg.read_bytes())}],
            'exportBounds':{'x':940,'y':320,'width':200,'height':100}}]
        self.plan['referencePacks'][0]['assetUses']=[{'nodeId':'image-node','assetId':'asset-node-image-node','role':'material','policy':'preserve'}]
        self.build();records={r['id']:r for r in json.loads((self.out/'records.json').read_text())};asset=records['asset-node-image-node'];use=records['ref-a']['design']['referencePack']['assetUses'][0]
        self.assertNotIn('originalImageHash',asset['media']);self.assertEqual(asset['media']['derivation']['type'],'reviewed-node-export')
        self.assertEqual(use['bounds']['x'],.7);self.assertEqual(use['bounds']['y'],.2);self.assertTrue(use['appearanceBaked'])
        self.assertEqual(use['renderTransform'],'axis-aligned-export-canvas');self.assertTrue(any(e.get('file','').endswith('.svg') for e in asset['evidence']))

    def test_exact_review_boundary_resolved_format_family_and_negative_provenance(self):
        result=self.build();records={r['id']:r for r in json.loads((self.out/'records.json').read_text())}
        self.assertEqual(result['references'],6);self.assertNotIn('ref-uninspected',records)
        self.assertEqual(records['ref-a']['design']['format']['width'],1200)
        self.assertEqual(records['ref-b']['design']['format']['height'],1200)
        self.assertEqual(records['ref-a']['design']['resizeLinks'],['ref-b'])
        self.assertEqual(records['ref-a']['links'],['ref-b','section-section','ref-negative'])
        self.assertEqual(records['ref-c']['design']['familyId'],'ref-c')
        self.assertEqual(records['ref-c']['design']['resizeLinks'],[])
        self.assertEqual(records['ref-negative']['polarity'],'negative');self.assertEqual(records['ref-dim']['polarity'],'unknown')
        self.assertIn('Explicit do-not-use annotation',records['ref-negative']['body'])
        self.assertEqual(records['section-section']['polarity'],'mixed')
        self.assertEqual(records['section-section']['design']['principles'],self.plan['sections'][0]['principles'])
        summary=records['ref-a']['design']['geometrySummary']
        self.assertEqual(summary['texts'][0]['fontName']['style'],'Bold');self.assertEqual(summary['texts'][0]['textTracking'],-1)
        self.assertEqual(len(summary['gradients'][0]['paint']['stops']),2)
        geometry=json.loads((self.out/records['ref-a']['geometry']['file']).read_text())
        self.assertEqual(geometry['nodes'][0]['rawField'],'preserved')
        self.assertEqual(records['ref-a']['scope'],'specific campaign')
        self.assertEqual((self.brand/'catalog.json').read_bytes(),self.catalog_before)

    def test_legacy_resources_and_evidence_remain_importable_without_raw_archive_copy(self):
        self.build();source=json.loads((self.out/'source.json').read_text());profile=json.loads((self.out/'authoring.json').read_text())
        records=json.loads((self.out/'records.json').read_text())
        self.assertEqual(profile['referencePageIds'],['page']);self.assertEqual(profile['referenceAudience'],'consumer')
        self.assertEqual(profile['requiredEvidence'],['old-rule']);self.assertIn('old:1',source['nodeIds'])
        self.assertEqual(source['referenceProvenance']['archive']['archiveDocumentId'],'lk-internal')
        self.assertEqual(source['referencePage']['sourceFigmaFileKey'],'figma-key')
        self.assertFalse(list(self.out.rglob('*.fig')))
        for record in records:library.validate(record,source,self.out)
        asset=next(r for r in records if r['kind']=='asset')
        self.assertEqual((self.out/asset['media']['file']).read_bytes(),b'original image bytes, Figma ID is not a byte SHA-1')
        from import_brand_snapshot import ingest
        imported=ingest('fixture',self.out,'Fixture',self.root/'destination')
        self.assertEqual(imported['records'],len(records))

    def test_other_page_or_section_cannot_be_inspected_and_families_need_explicit_members(self):
        original=copy.deepcopy(self.plan)
        for mutate in [lambda: self.plan.update(pageId='other-page'),
                       lambda: self.plan['sections'][0]['inspectedNodeIds'].append('foreign-node'),
                       lambda: self.plan['sections'][0]['families'][0]['nodeIds'].append('uninspected'),
                       lambda: self.plan['sections'][0]['inspectedNodeIds'].append('loose')]:
            self.plan=copy.deepcopy(original);mutate()
            with self.assertRaises(ValueError):self.build()
            self.assertFalse(self.out.exists())

    def test_missing_or_changed_visual_evidence_cannot_be_promoted(self):
        original=copy.deepcopy(self.crops)
        self.crops[0].pop('file');self.save_source()
        with self.assertRaisesRegex(ValueError,'no visible crop'):self.build()
        self.crops=original;self.crops[0]['sha256']='wrong';self.save_source()
        with self.assertRaisesRegex(ValueError,'checksum'):self.build()
        self.assertFalse(self.out.exists())

    def test_unknown_bounds_and_foreign_asset_provenance_are_rejected(self):
        self.bounds[0]['box']['width']=None;self.save_source()
        with self.assertRaisesRegex(ValueError,'resolved format'):self.build()
        self.bounds[0]['box']['width']=1200;self.save_source();self.plan['assets'][0]['sourceNodeId']='foreign'
        with self.assertRaisesRegex(ValueError,'selected page'):self.build()

    def test_geometry_excerpts_are_bounded_and_do_not_replace_full_source(self):
        text={'nodeId':'t','characters':'x'*500,'fontSize':30,'fontName':{'family':'Fixture','style':'Medium'}}
        paint={'nodeId':'p','paints':[{'type':'GRADIENT_LINEAR','stops':[{'position':0},{'position':1}],'transform':{'m00':1}}]}
        result=geometry_summary({'texts':[text]*30,'paints':[paint]*20,'effects':[{'effects':[{'radius':1}]*10}]*20,'radii':[{'radius':20}]*20})
        self.assertEqual(len(result['texts']),8);self.assertEqual(len(result['texts'][0]['characters']),180)
        self.assertEqual(len(result['gradients']),3);self.assertEqual(len(result['effects']),5);self.assertEqual(len(result['effects'][0]['effects']),3)
        self.assertEqual(len(result['radii']),5);self.assertEqual(len(text['characters']),500)

    def test_explicit_source_annotations_keep_scope_and_can_be_required_evidence(self):
        self.plan['rules']=[{'nodeId':'image-node','title':'Asset direction','body':'This asset board asks for a metallic coin; this is not a global palette ban.',
            'scope':'this asset board only','polarity':'mixed','authority':'explicit','links':['a','section-section']}]
        self.plan['requiredRuleNodeIds']=['image-node']
        self.build();records={r['id']:r for r in json.loads((self.out/'records.json').read_text())}
        profile=json.loads((self.out/'authoring.json').read_text());rule=records['rule-image-node']
        self.assertEqual(rule['scope'],'this asset board only');self.assertEqual(rule['authority'],'explicit')
        self.assertTrue(rule['mandatory']);self.assertEqual(rule['links'],['ref-a','section-section'])
        self.assertEqual(profile['requiredEvidence'],['old-rule','rule-image-node'])
        self.assertIn('not a global palette ban',rule['body'])

    def test_required_unreviewed_annotation_and_dangling_rule_links_are_rejected(self):
        self.plan['requiredRuleNodeIds']=['image-node']
        with self.assertRaisesRegex(ValueError,'not explicitly reviewed'):self.build()
        self.plan['rules']=[{'nodeId':'image-node','title':'Board note','body':'Scoped annotation','scope':'this board',
                            'polarity':'neutral','authority':'explicit','links':['uninspected']}]
        with self.assertRaisesRegex(ValueError,'missing or ambiguous'):self.build()
        self.assertFalse(self.out.exists())

    def test_campaigns_are_explicit_and_independent_from_resize_families(self):
        self.plan['campaigns']=[{'id':'shared-campaign','nodeIds':['a','b','c']}]
        result=self.build();records={r['id']:r for r in json.loads((self.out/'records.json').read_text())}
        for node_id in ['a','b','c']:self.assertEqual(records['ref-'+node_id]['design']['campaignId'],'shared-campaign')
        self.assertEqual(records['ref-a']['design']['resizeLinks'],['ref-b'])
        self.assertEqual(records['ref-c']['design']['resizeLinks'],[])
        self.assertNotIn('campaignId',records['ref-loose']['design'])
        self.assertEqual(result['coverage']['explicitCampaigns'],1)

    def test_campaigns_reject_uninspected_nodes_and_duplicate_assignments(self):
        for campaigns in [[{'id':'campaign','nodeIds':['uninspected']}],
                          [{'id':'campaign','nodeIds':['a','a']}],
                          [{'id':'first','nodeIds':['a']},{'id':'second','nodeIds':['a']}],
                          [{'id':'duplicate','nodeIds':['a']},{'id':'duplicate','nodeIds':['c']}]]:
            self.plan['campaigns']=campaigns
            with self.assertRaisesRegex(ValueError,'Campaign|campaign'):self.build()
            self.assertFalse(self.out.exists())

    def test_second_bundle_explicitly_refreshes_only_generated_records_of_same_page(self):
        self.plan['rules']=[{'nodeId':'image-node','title':'Old required annotation','body':'Previously required board note','scope':'this board','polarity':'neutral','authority':'explicit'}]
        self.plan['requiredRuleNodeIds']=['image-node']
        self.build()
        records=json.loads((self.out/'records.json').read_text())
        foreign=copy.deepcopy(next(r for r in records if r['id']=='ref-a'))
        foreign.update(id='ref-other-page',links=[]);foreign['design']['pageId']='other-page';records.append(foreign)
        legacy_asset=copy.deepcopy(next(r for r in records if r['kind']=='asset'));legacy_asset['id']='asset-old-original';records.append(legacy_asset)
        write(self.out/'records.json',records)
        from import_brand_snapshot import ingest
        ingest('fixture',self.out,'Fixture',self.root/'destination')
        current=self.root/'destination/fixture';before=(current/'catalog.json').read_bytes()
        write(self.plan_path,self.plan)
        with self.assertRaisesRegex(ValueError,'collision'):
            build_bundle(current,self.page,self.plan_path,self.root/'collision')
        self.plan.update(replacePageEvidence=True,campaigns=[{'id':'new-campaign','nodeIds':['a','b']}],requiredRuleNodeIds=[],rules=[])
        write(self.plan_path,self.plan)
        refreshed=self.root/'refreshed';result=build_bundle(current,self.page,self.plan_path,refreshed)
        new_records=json.loads((refreshed/'records.json').read_text());by={r['id']:r for r in new_records}
        self.assertEqual(len(by),len(new_records));self.assertEqual(len(new_records),len(records)-1)
        self.assertEqual(by['ref-a']['design']['campaignId'],'new-campaign')
        self.assertEqual(by['ref-other-page']['design']['pageId'],'other-page')
        self.assertEqual(by['asset-old-original']['design']['pageId'],'page')
        self.assertIn('old-rule',by);self.assertNotIn('rule-image-node',by)
        profile=json.loads((refreshed/'authoring.json').read_text())
        self.assertNotIn('rule-image-node',profile['requiredEvidence']);self.assertIn('old-rule',profile['requiredEvidence'])
        self.assertEqual(result['coverage']['replacedPageRecords'],9)
        self.assertEqual((current/'catalog.json').read_bytes(),before)

    def test_refresh_rejects_dangling_preserved_links_instead_of_silently_changing_them(self):
        self.build();records=json.loads((self.out/'records.json').read_text())
        next(r for r in records if r['id']=='old-rule')['links']=['ref-loose'];write(self.out/'records.json',records)
        from import_brand_snapshot import ingest
        ingest('fixture',self.out,'Fixture',self.root/'destination')
        self.plan.update(replacePageEvidence=True,loose=[]);write(self.plan_path,self.plan)
        with self.assertRaisesRegex(ValueError,'after explicit page replacement: old-rule -> ref-loose'):
            build_bundle(self.root/'destination/fixture',self.page,self.plan_path,self.root/'rejected')
        self.assertFalse((self.root/'rejected').exists())


if __name__=='__main__':unittest.main()
