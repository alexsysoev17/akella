import hashlib
import io
import json
import pathlib
import tempfile
import unittest
import zipfile
from PIL import Image
from extract_fig_assets import extract
from normalize_fig_geometry import normalize


class FigIngestionTests(unittest.TestCase):
    def test_extracts_only_hash_mapped_original_and_does_not_auto_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=pathlib.Path(tmp);stream=io.BytesIO();Image.new('RGBA',(2,2),(255,0,0,0)).save(stream,format='PNG');content=stream.getvalue();digest=hashlib.sha1(content).hexdigest()
            with zipfile.ZipFile(root/'source.fig','w') as archive:
                archive.writestr('images/'+digest,content);archive.writestr('../outside',b'not extracted')
            (root/'inventory.json').write_text(json.dumps({'assetNodes':[{'id':'1:2','imageHash':digest}]}))
            self.assertEqual(extract(root/'source.fig',root/'inventory.json',root/'out')['extracted'],1)
            manifest=json.loads((root/'out/manifest.json').read_text());self.assertEqual(manifest[0]['status'],'downloaded-unreviewed');self.assertTrue(manifest[0]['alpha'])
            self.assertEqual((root/'out'/manifest[0]['file']).read_bytes(),content);self.assertFalse((root/'outside').exists())
            with zipfile.ZipFile(root/'source.fig','w') as archive:archive.writestr('images/'+digest,b'changed')
            with self.assertRaisesRegex(ValueError,'hash'):extract(root/'source.fig',root/'inventory.json',root/'out2')

    def test_page_scope_and_hidden_ancestors_are_preserved(self):
        def node(id,type,parent=None,**values):
            n={'guid':{'sessionID':0,'localID':id},'phase':'CREATED','type':type,**values}
            if parent is not None:n['parentIndex']={'guid':{'sessionID':0,'localID':parent},'position':'!'}
            return n
        doc={'nodeChanges':[node(1,'CANVAS'),node(2,'CANVAS'),node(3,'FRAME',1,visible=False,cornerRadius=17),node(4,'TEXT',3,fontSize=40,textData={'characters':'Example'}),node(5,'TEXT',2,fontSize=90)]}
        result=normalize(doc,['0:1']);self.assertEqual([n['id'] for n in result['nodes']],['0:1','0:3','0:4']);self.assertFalse(result['nodes'][2]['effectiveVisible']);self.assertEqual(result['nodes'][1]['cornerRadius'],17)
        self.assertNotIn('globalTokens',result)


if __name__=='__main__':unittest.main()
