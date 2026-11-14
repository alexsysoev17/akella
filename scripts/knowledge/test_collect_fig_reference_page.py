import hashlib,io,json,pathlib,subprocess,sys,tempfile,unittest,zipfile
from PIL import Image
from collect_fig_reference_page import collect


def gid(value):
    session,local=map(int,value.split(':'));return {'sessionID':session,'localID':local}


def node(id,type,parent=None,name='',x=0,y=0,w=100,h=50,position='! ',**props):
    return {'guid':gid(id),'phase':'CREATED','type':type,'name':name,'parentIndex':{'guid':gid(parent) if parent else None,'position':position},'visible':True,'opacity':1,'size':{'x':w,'y':h},
            'transform':{'m00':1,'m01':0,'m02':x,'m10':0,'m11':1,'m12':y},**props}


class PageCollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        image=Image.new('RGBA',(4,3),(255,0,0,100));stream=io.BytesIO();image.save(stream,format='PNG');self.image=stream.getvalue();self.key=hashlib.sha1(self.image).hexdigest()
        self.paint={'type':'IMAGE','visible':True,'image':{'hash':list(bytes.fromhex(self.key))},'transform':{'m00':1,'m01':0,'m02':0,'m10':0,'m11':1,'m12':0},'imageScaleMode':'CROP'}
        self.nodes=[node('0:0','DOCUMENT'),node('1:1','CANVAS','0:0',name='selected'),node('2:1','CANVAS','0:0',name='excluded'),
            node('1:2','SECTION','1:1',name='Only composition',x=100,y=200),
            node('1:3','FRAME','1:2',name='Wide',x=10,y=20,w=200,h=100,fillPaints=[self.paint]),
            node('1:4','TEXT','1:3',textData={'characters':'Shared headline'},fontName={'family':'Fixture','style':'Bold'},fontSize=40,letterSpacing={'value':-1,'units':'PERCENT'},lineHeight={'value':44,'units':'PIXELS'},fillGeometry=[{'commandsBlob':1}]),
            node('1:5','TEXT','1:2',name='Note',textData={'characters':'Keep visual treatment'},position='z'),
            node('1:6','INSTANCE','1:1',name='Loose instance',symbolData={'symbolID':gid('2:3'),'symbolOverrides':[{'fillPaints':[self.paint]}]}),
            node('2:2','FRAME','2:1',name='Other page',fillPaints=[{'type':'IMAGE','image':{'hash':list(bytes.fromhex('f'*40))}}],fillGeometry=[{'commandsBlob':0}]),
            node('2:3','SYMBOL','2:1',name='External component')]
        self.decoded=self.root/'decoded.json';self.archive=self.root/'source.fig'
        self.write_source()
    def write_source(self,include_image=True):
        self.decoded.write_text(json.dumps({'originFileKey':'fixture','nodeChanges':self.nodes,'blobs':[{'bytes':{'0':99}},{'bytes':{'0':42}}]}))
        with zipfile.ZipFile(self.archive,'w') as z:
            if include_image:z.writestr('images/'+self.key,self.image)
            z.writestr('images/'+'f'*40,b'out-of-page bytes must never be read')
    def tearDown(self):self.temp.cleanup()
    def test_only_selected_page_geometry_images_and_blobs_are_collected(self):
        out=self.root/'out';report=collect(self.decoded,self.archive,'1:1',out)
        self.assertEqual(report['counts']['nodes'],6);self.assertEqual(report['counts']['sections'],1);self.assertEqual(report['counts']['references'],2)
        self.assertEqual(report['counts']['uniqueImageFills'],1);self.assertEqual(report['counts']['imagesCollected'],1)
        images=json.loads((out/'images.json').read_text());self.assertEqual(images[0]['usedByNodeIds'],['1:3','1:6']);self.assertTrue(images[0]['hasTransparency']);self.assertEqual(images[0]['sha256'],hashlib.sha256(self.image).hexdigest())
        self.assertEqual(set(json.loads((out/'raw-node-index.json').read_text())),{'1:1','1:2','1:3','1:4','1:5','1:6'})
        self.assertEqual(set(json.loads((out/'blobs.json').read_text())['originalBlobIndices']),{'1'})
    def test_transforms_notes_and_raw_typography_preserved_without_universal_rules(self):
        self.nodes[3]['transform']={'m00':0,'m01':-1,'m02':100,'m10':1,'m11':0,'m12':200};self.write_source()
        out=self.root/'out';collect(self.decoded,self.archive,'1:1',out)
        refs=json.loads((out/'references.json').read_text());frame=next(r for r in refs if r['id']=='1:3')
        self.assertEqual(frame['absoluteTransform'],[0,-1,80,1,0,210]);self.assertEqual(frame['relativeTransform'],[1,0,10,0,1,20])
        notes=json.loads((out/'notes.json').read_text());self.assertEqual([n['id'] for n in notes],['1:5']);self.assertEqual(notes[0]['characters'],'Keep visual treatment')
        summary=json.loads((out/frame['summaryFile']['file']).read_text());self.assertEqual(summary['texts'][0]['letterSpacing'],{'value':-1,'units':'PERCENT'})
        self.assertEqual(frame['status'],'collected-unreviewed')
    def test_component_overrides_reported_without_importing_outside_page_definition(self):
        out=self.root/'out';collect(self.decoded,self.archive,'1:1',out)
        instance=json.loads((out/'component-resolution.json').read_text())[0]
        self.assertTrue(instance['componentDefinitionPresentInSource']);self.assertFalse(instance['componentDefinitionInSelectedPage']);self.assertEqual(instance['overrideCount'],1);self.assertEqual(instance['resolution'],'not-resolved')
    def test_missing_image_and_blob_are_explicit_not_silently_complete(self):
        self.nodes[5]['fillGeometry']=[{'commandsBlob':8}];self.write_source(False)
        out=self.root/'out';report=collect(self.decoded,self.archive,'1:1',out)
        self.assertEqual(report['counts']['missingImages'],1);self.assertEqual(report['counts']['missingBlobs'],1)
        self.assertEqual(json.loads((out/'images.json').read_text())[0]['status'],'missing')
    def test_source_image_hash_mismatch_is_rejected(self):
        with zipfile.ZipFile(self.archive,'w') as z:z.writestr('images/'+self.key,b'changed')
        with self.assertRaisesRegex(ValueError,'hash mismatch'):collect(self.decoded,self.archive,'1:1',self.root/'out')
    def test_unknown_page_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'Missing selected page'):collect(self.decoded,self.archive,'99:99',self.root/'out')
    def test_unknown_size_and_singular_reference_preserve_unknown_bounds(self):
        self.nodes[4]['size']={'x':None,'y':100};self.nodes[4]['transform']['m00']=0;self.nodes[4]['transform']['m11']=0;self.write_source()
        out=self.root/'out';collect(self.decoded,self.archive,'1:1',out)
        frame=next(r for r in json.loads((out/'references.json').read_text()) if r['id']=='1:3')
        self.assertIsNone(frame['absoluteBounds'])
        geometry=json.loads((out/frame['geometry']['file']).read_text())
        self.assertIsNone(geometry['nodes'][0]['relativeTransform']);self.assertIsNone(geometry['nodes'][0]['relativeBounds'])
    def test_cli_keeps_archive_document_id_separate_from_explicit_figma_file_key(self):
        script=pathlib.Path(__file__).with_name('collect_fig_reference_page.py');out=self.root/'cli-output'
        result=subprocess.run([sys.executable,str(script),str(self.decoded),str(self.archive),'1:1',str(out),'--file-key','ActualFigmaDesignKey'],text=True,capture_output=True,check=True)
        self.assertEqual(json.loads(result.stdout)['page']['id'],'1:1')
        source=json.loads((out/'manifest.json').read_text())['source']
        self.assertEqual(source['archiveDocumentId'],'fixture');self.assertEqual(source['sourceFigmaFileKey'],'ActualFigmaDesignKey');self.assertNotIn('fileKey',source)
        no_key=collect(self.decoded,self.archive,'1:1',self.root/'no-key')
        self.assertIsNone(no_key['source']['sourceFigmaFileKey']);self.assertEqual(no_key['source']['sourceFigmaFileKeyAuthority'],'unknown')

if __name__=='__main__':unittest.main()
