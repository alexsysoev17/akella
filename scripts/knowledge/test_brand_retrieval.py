"""Retrieval contracts on independent synthetic brands; no client assets or models."""
import json
import copy
import os
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import brand_library as b


class DesignRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name);self.base=self.root/'brand';self.base.mkdir()
        (self.base/'source.json').write_text(json.dumps({'nodeIds':['1:1']}))
        (self.base/'frame.png').write_bytes(b'synthetic image fixture')
        evidence={'nodeId':'1:1','file':'source.json','fileSha256':b.sha((self.base/'source.json').read_bytes()),'image':'frame.png','imageSha256':b.sha((self.base/'frame.png').read_bytes())}
        self.records=[]
        for key,page,family,width,height,polarity in [
            ('a-wide','p1','a',1200,600,'positive'),('a-tall','p1','a',600,1200,'positive'),
            ('b-tall','p1','b',600,1200,'positive'),('same-family-other-page','p2','a',600,1200,'positive'),
            ('negative','p1','negative',1200,600,'negative')]:
            self.records.append({'id':key,'kind':'example','title':'Баннер '+key,'body':'Композиция и цвет','status':'reviewed','authority':'observed','polarity':polarity,'scope':'fixture',
                'evidence':[dict(evidence)],'links':[],'review':{'by':'fixture'},'design':{'pageId':page,'familyId':family,'role':'advertisement','format':{'width':width,'height':height}}})
        self.records[0]['links']=['negative']
        self.records.append({'id':'mandatory','kind':'rule','title':'Логотип','body':'Original proportions','status':'reviewed','authority':'explicit','polarity':'neutral','scope':'brand',
            'evidence':[dict(evidence)],'links':[],'review':{'by':'fixture'},'mandatory':True})
        self.save()

    def save(self):
        (self.base/'records.json').write_text(json.dumps(self.records));(self.base/'catalog.json').write_text(json.dumps({'source':'source.json','records':'records.json','snapshot':'s1','coverage':{}}));b.build('brand',self.root)

    def tearDown(self):self.temp.cleanup()

    def request(self,**options):
        return b.search('brand','Баннер',root=self.root,mode='lexical',**options)

    def test_reference_filters_select_page_role_and_positive_examples(self):
        r=self.request(kinds=['example'],filters={'pageId':'p1','role':'advertisement','polarity':'positive'})
        self.assertEqual({x['id'] for x in r['results']},{'a-wide','a-tall','b-tall'})
        self.assertEqual([x['id'] for x in r['required']],['mandatory'])

    def test_family_siblings_expand_but_other_page_cannot_leak(self):
        r=self.request(limit=1,filters={'pageId':'p1','familyId':'a','polarity':'positive'},targetFormat={'width':1200,'height':600})
        self.assertEqual(r['results'][0]['id'],'a-wide')
        self.assertIn('a-tall',{x['id'] for x in r['related']})
        self.assertNotIn('same-family-other-page',{x['id'] for x in r['related']})
        self.assertEqual(next(x for x in r['related'] if x['id']=='negative')['polarity'],'negative')

    def test_target_format_prefers_matching_composition_without_rejecting_others(self):
        r=self.request(filters={'pageId':'p1','polarity':'positive'},targetFormat={'width':300,'height':600})
        self.assertEqual(r['results'][0]['design']['format'],{'width':600,'height':1200})
        self.assertIn('a-wide',{x['id'] for x in r['results']})
        self.assertTrue(all('aspectLogDistance' in x['retrieval'] for x in r['results']))

    def test_diversification_prevents_sibling_resizes_crowding_out_different_ideas(self):
        order,_=b.layout_order(['a-wide','a-tall','b-tall'],{r['id']:r for r in self.records},None,True)
        self.assertEqual(order,['a-wide','b-tall','a-tall'])

    def test_campaign_diversity_does_not_convert_different_creatives_into_resize_siblings(self):
        for r in self.records[:3]:r['design']['campaignId']='shared-campaign'
        self.records[3]['design']['campaignId']='different-campaign'
        order,_=b.layout_order(['a-wide','b-tall','same-family-other-page','a-tall'],{r['id']:r for r in self.records},None,True)
        self.assertEqual(order,['a-wide','same-family-other-page','b-tall','a-tall'])
        self.save()
        result=self.request(limit=1,filters={'familyId':'a','pageId':'p1'},targetFormat={'width':1200,'height':600})
        self.assertIn('a-tall',{r['id'] for r in result['related']})
        self.assertNotIn('b-tall',{r['id'] for r in result['related']})
        self.records[0]['design']['campaignId']=['not-a-string']
        with self.assertRaisesRegex(ValueError,'Invalid design campaignId'):self.save()

    def test_unknown_channel_is_not_invented_or_silently_matched(self):
        self.assertEqual(self.request(filters={'channel':'splashscreen'})['results'],[])

    def test_reference_pack_filter_is_boolean_and_combines_with_page_and_polarity(self):
        self.records[0]['design']['referencePack']={'version':1,'coordinateSpace':'normalized-visual-frame','sourceNodeId':'1:1','scope':'fixture','anchors':[],'assetUses':[]}
        self.save()
        self.assertEqual([r['id'] for r in self.request(filters={'hasReferencePack':True,'pageId':'p1','polarity':'positive'})['results']],['a-wide'])
        self.assertNotIn('a-wide',[r['id'] for r in self.request(filters={'hasReferencePack':False})['results']])
        for value in ['true',1,None]:
            with self.assertRaises(ValueError):b.request_options({'query':'banner','filters':{'hasReferencePack':value}})

    def test_consumer_audience_excludes_employee_and_unknown_examples(self):
        self.records[0]['design']['audience']='consumer'
        self.records[1]['design']['audience']='employee'
        self.records[2]['design']['audience']='unspecified'
        self.save()
        self.assertEqual([r['id'] for r in self.request(filters={'audience':'consumer'})['results']],['a-wide'])
        self.assertEqual([r['id'] for r in self.request(filters={'audience':'employee'})['results']],['a-tall'])
        self.assertEqual([r['id'] for r in self.request(filters={'audience':'unspecified'})['results']],['b-tall'])
        self.assertEqual(self.request(filters={'audience':'partner'})['results'],[])
        self.assertEqual(len(self.request(kind='example')['results']),5)

    def test_audience_filters_related_compositions_without_losing_negative_warnings(self):
        self.records[0]['design']['audience']='consumer'
        self.records[1]['design']['audience']='consumer'
        self.records[2]['design'].update({'audience':'employee','familyId':'a'})
        self.records[3]['design']['audience']='employee'
        self.records[4]['design']['audience']='employee'
        self.records[0]['links']+=['b-tall']
        self.save()
        r=self.request(limit=1,filters={'audience':'consumer','polarity':'positive'},targetFormat={'width':1200,'height':600})
        self.assertEqual([x['id'] for x in r['results']],['a-wide'])
        self.assertEqual({x['id'] for x in r['related']},{'a-tall','negative'})
        self.assertEqual([x['id'] for x in r['required']],['mandatory'])

    def test_audience_is_searchable_generic_string_metadata_and_invalid_types_fail(self):
        self.records[0]['design']['audience']='partner'
        self.save()
        r=b.search('brand','partner',root=self.root,mode='lexical',filters={'audience':'partner'})
        self.assertEqual([x['id'] for x in r['results']],['a-wide'])
        self.assertIn('partner',b.search_text(self.records[0]))
        self.records[0]['design']['audience']=['consumer']
        with self.assertRaisesRegex(ValueError,'Invalid design audience'):self.save()
        for invalid in ['',7,['consumer']]:
            with self.assertRaises(ValueError):b.request_options({'query':'banner','filters':{'audience':invalid}})

    def test_large_section_links_are_bounded_together_with_family_siblings(self):
        section=copy.deepcopy(self.records[0]);section.update(id='large-section',kind='composition',title='Sectionstudy',body='Reviewed section study',links=[])
        section['design'].pop('familyId');self.records.append(section)
        for index in range(256):
            record=copy.deepcopy(self.records[0]);record.update(id='section-member-'+str(index),links=[],title='Member '+str(index))
            record['design']['format']={'width':1200 if index>230 else 600,'height':600 if index>230 else 1200}
            self.records.append(record);section['links'].append(record['id'])
        section['links']+=['negative','mandatory']
        # Searching a large study used to emit all 256 linked records before any TS context cap.
        self.save()
        result=b.search('brand','Sectionstudy',root=self.root,mode='lexical',kind='composition',targetFormat={'width':1200,'height':600})
        self.assertEqual([r['id'] for r in result['results']],['large-section'])
        self.assertEqual(len(result['related']),24)
        self.assertEqual([r['id'] for r in result['related'][:2]],['negative','mandatory'])
        self.assertTrue(all(r['design']['format']=={'width':1200,'height':600} for r in result['related'][2:]))
        self.assertEqual(result['diagnostics']['relatedTotal'],258)
        self.assertEqual(result['diagnostics']['relatedTruncated'],234)
        # Explicit links plus automatic siblings share one limit, with no duplicate records.
        self.records[0]['links']=['large-section','negative']+[r['id'] for r in self.records if r['id'].startswith('section-member-')][:250]
        self.save()
        result=self.request(limit=1,filters={'familyId':'a'},targetFormat={'width':1200,'height':600})
        self.assertEqual(len(result['related']),24)
        self.assertEqual(len({r['id'] for r in result['related']}),24)
        self.assertEqual(result['related'][0]['id'],'negative')
        self.assertIn('large-section',{r['id'] for r in result['related']})

    def test_batch_matches_legacy_search_and_reports_per_query_timings(self):
        requests=[{'query':'Баннер','mode':'lexical','kind':'example'},{'query':'Логотип','mode':'lexical','kind':'rule'}]
        result=b.search_batch('brand',requests,self.root)
        for request,actual in zip(requests,result['results']):
            expected=b.search('brand',request['query'],kind=request['kind'],mode='lexical',root=self.root)
            self.assertEqual([x['id'] for x in actual['results']],[x['id'] for x in expected['results']])
            self.assertGreaterEqual(actual['diagnostics']['timings']['totalMs'],0)
        self.assertEqual(result['diagnostics']['queries'],2)

    def test_batch_detects_source_mutation_between_requests(self):
        original=b._search;calls=0
        def mutate(*args,**kwargs):
            nonlocal calls
            if calls==1:(self.base/'frame.png').write_bytes(b'changed frame')
            calls+=1;return original(*args,**kwargs)
        with patch.object(b,'_search',side_effect=mutate),self.assertRaisesRegex(ValueError,'Changed evidence'):
            b.search_batch('brand',[{'query':'Баннер','mode':'lexical'}]*2,self.root)

    def test_batch_detects_catalog_change_even_if_snapshot_label_reused(self):
        original=b._search;calls=0
        def mutate(*args,**kwargs):
            nonlocal calls
            if calls==1:
                catalog=json.loads((self.base/'catalog.json').read_text());catalog['coverage']={'updated':True}
                (self.base/'catalog.json').write_text(json.dumps(catalog));b.build('brand',self.root)
            calls+=1;return original(*args,**kwargs)
        with patch.object(b,'_search',side_effect=mutate),self.assertRaisesRegex(ValueError,'snapshot changed during batch'):
            b.search_batch('brand',[{'query':'Баннер','mode':'lexical'}]*2,self.root)

    def test_invalid_requests_and_metadata_rejected(self):
        for requests in [[],[{'query':'a'}]*9,[{'query':'a','filters':{'surprise':'x'}}],[{'query':'a','targetFormat':{'width':0,'height':1}}]]:
            with self.assertRaises(ValueError):b.search_batch('brand',requests,self.root)
        self.records[0]['design']['format']['width']=-1
        with self.assertRaisesRegex(ValueError,'Invalid design format'):self.save()

    def test_hash_cache_checks_mutation_even_if_file_size_and_mtime_restored(self):
        p=self.base/'frame.png';runtime=b.BatchRuntime();before=runtime.file_hash(p);stat=p.stat()
        p.write_bytes(b'X'*stat.st_size);os.utime(p,ns=(stat.st_atime_ns,stat.st_mtime_ns))
        self.assertNotEqual(runtime.file_hash(p),before)

if __name__=='__main__':unittest.main()
