import json,pathlib,tempfile,unittest
import brand_library as b
class EvidenceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name)
  for brand in ['a','b']:
   d=self.root/brand;d.mkdir();(d/'source.json').write_text(json.dumps({'nodeIds':['1:1']}))
   records=[{'id':brand+'-rule','kind':'rule','title':'Логотип','body':'Сохранять пропорции логотипа '+brand,'status':'reviewed','authority':'explicit','polarity':'neutral','scope':'brand','evidence':[{'nodeId':'1:1','file':'source.json','fileSha256':b.sha((d/'source.json').read_bytes())}],'links':[],'review':{'by':'fixture'}}]
   (d/'records.json').write_text(json.dumps(records));(d/'catalog.json').write_text(json.dumps({'source':'source.json','records':'records.json','coverage':{'visual':'unreviewed'}}));b.build(brand,self.root)
 def tearDown(self):self.tmp.cleanup()
 def test_isolation(self):
  result=b.search('a','логотип',root=self.root,mode='lexical');self.assertEqual([x['id'] for x in result['results']],['a-rule'])
 def test_stale_index(self):
  (self.root/'a'/'source.json').write_text('{}')
  with self.assertRaisesRegex(ValueError,'Source changed'):b.search('a','логотип',root=self.root)
 def test_review_and_visual_evidence_required(self):
  p=self.root/'a'/'records.json';rs=json.loads(p.read_text());rs[0]['kind']='example';p.write_text(json.dumps(rs))
  with self.assertRaisesRegex(ValueError,'inspected image'):b.build('a',self.root)
 def test_unsafe_brand(self):
  with self.assertRaises(ValueError):b.collection('../b',self.root)
 def test_dangling_links(self):
  p=self.root/'a'/'records.json';rs=json.loads(p.read_text());rs[0]['links']=['missing'];p.write_text(json.dumps(rs))
  with self.assertRaisesRegex(ValueError,'Broken'):b.build('a',self.root)
 def test_unreviewed_not_reference(self):
  p=self.root/'a'/'records.json';rs=json.loads(p.read_text());rs[0]['status']='unreviewed';p.write_text(json.dumps(rs));b.build('a',self.root)
  self.assertEqual(b.search('a','логотип',root=self.root)['results'],[])
 def test_negative_example_keeps_role_when_linked(self):
  p=self.root/'a'/'records.json';rs=json.loads(p.read_text());negative=json.loads(json.dumps(rs[0]))
  negative.update(id='bad-example',kind='example',title='Forbidden',body='Неправильная перекраска',polarity='negative')
  image=self.root/'a'/'example.png';image.write_bytes(b'fixture image bytes')
  negative['evidence'][0].update(image='example.png',imageSha256=b.sha(image.read_bytes()))
  rs[0]['links']=['bad-example'];p.write_text(json.dumps(rs+[negative]));b.build('a',self.root)
  result=b.search('a','логотип',limit=1,root=self.root,mode='lexical')
  self.assertEqual(result['related'][0]['polarity'],'negative')
  image.write_bytes(b'changed image')
  with self.assertRaisesRegex(ValueError,'Changed evidence'):b.search('a','логотип',limit=1,root=self.root,mode='lexical')
class ImportTests(unittest.TestCase):
 def test_authoring_profile_follows_snapshot_and_missing_evidence_cannot_activate(self):
  from import_brand_snapshot import ingest
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);bundle=root/'bundle';bundle.mkdir()
   (bundle/'source.json').write_text(json.dumps({'nodeIds':['1:1']}));(bundle/'coverage.json').write_text('{}')
   digest=b.sha((bundle/'source.json').read_bytes())
   record={'id':'logo-rule','kind':'rule','title':'Logo','body':'Original proportions','status':'reviewed','authority':'explicit','polarity':'neutral','scope':'brand','evidence':[{'nodeId':'1:1','file':'source.json','fileSha256':digest}],'links':[],'review':{'by':'fixture'}}
   (bundle/'records.json').write_text(json.dumps([record]))
   profile={'version':1,'snapshot':'old','requiredEvidence':['logo-rule'],'resources':[{'id':'font','kind':'font','file':'source.json','sha256':digest}]}
   (bundle/'authoring.json').write_text(json.dumps(profile));ingest('brand',bundle,'Brand',root/'brands')
   base=root/'brands/brand';catalog=json.loads((base/'catalog.json').read_text());before=(base/'catalog.json').read_bytes()
   imported=json.loads((base/catalog['authoring']).read_text())
   self.assertEqual(imported['snapshot'],catalog['snapshot']);self.assertEqual(imported['resources'],catalog['resources'])
   self.assertEqual(b.sha((base/imported['resources'][0]['file']).read_bytes()),digest)
   profile['requiredEvidence']=['missing'];(bundle/'authoring.json').write_text(json.dumps(profile))
   with self.assertRaisesRegex(ValueError,'Unknown authoring evidence'):ingest('brand',bundle,'Brand',root/'brands')
   self.assertEqual((base/'catalog.json').read_bytes(),before)
 def test_import_isolated_snapshot_and_rollback(self):
  from import_brand_snapshot import ingest
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);bundle=root/'bundle';bundle.mkdir();(bundle/'source.json').write_text(json.dumps({'nodeIds':['1:1']}));(bundle/'coverage.json').write_text('{}')
   record={'id':'r','kind':'rule','title':'Logo','body':'Keep proportions','status':'reviewed','authority':'explicit','polarity':'neutral','scope':'brand','evidence':[{'nodeId':'1:1','file':'source.json','fileSha256':b.sha((bundle/'source.json').read_bytes())}],'links':[],'review':{'by':'fixture'}}
   record['geometry']={'file':'source.json','sha256':b.sha((bundle/'source.json').read_bytes())}
   (bundle/'resources.json').write_text(json.dumps([{'id':'font','kind':'font','file':'source.json','sha256':b.sha((bundle/'source.json').read_bytes())}]))
   (bundle/'records.json').write_text(json.dumps([record]));ingest('brand',bundle,'Brand',root/'brands');base=root/'brands/brand';before=(base/'catalog.json').read_bytes()
   record['links']=['missing'];(bundle/'records.json').write_text(json.dumps([record]))
   with self.assertRaisesRegex(ValueError,'Broken'):ingest('brand',bundle,'Brand',root/'brands')
   self.assertEqual((base/'catalog.json').read_bytes(),before);self.assertEqual(b.search('brand','Logo',root=root/'brands',mode='lexical')['results'][0]['id'],'r')
   record['links']=[];record['body']='Updated proportions';(bundle/'records.json').write_text(json.dumps([record]))
   from unittest.mock import patch
   import import_brand_snapshot
   original=import_brand_snapshot.build
   def check_during_build(*args):
    self.assertEqual((base/'catalog.json').read_bytes(),before)
    self.assertEqual(b.search('brand','Logo',root=root/'brands',mode='lexical')['results'][0]['body'],'Keep proportions')
    return original(*args)
   with patch.object(import_brand_snapshot,'build',side_effect=check_during_build):ingest('brand',bundle,'Brand',root/'brands')
   self.assertNotEqual((base/'catalog.json').read_bytes(),before)
   self.assertEqual(b.search('brand','Logo',root=root/'brands',mode='lexical')['results'][0]['body'],'Updated proportions')
   self.assertEqual(len(list((base/'snapshots').iterdir())),2)
   result=b.search('brand','Logo',root=root/'brands',mode='lexical')
   self.assertTrue(result['resources'][0]['file'].startswith('snapshots/'))

if __name__=='__main__':unittest.main()
