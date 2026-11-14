"""Original reference coordinates must survive resource preparation."""
import hashlib
import json
import pathlib
import tempfile
import unittest

from PIL import Image
from banner_assets import prepare


class AssetPreparationTests(unittest.TestCase):
    def test_reference_pack_keeps_original_alpha_canvas_while_plain_assets_trim(self):
        with tempfile.TemporaryDirectory() as directory:
            root=pathlib.Path(directory);(root/'resources').mkdir()
            image=Image.new('RGBA',(20,30));image.paste((255,0,0,255),(5,7,15,23));image.save(root/'resources/original.png')
            original=(root/'resources/original.png').read_bytes();digest=hashlib.sha256(original).hexdigest()
            resources=[{'id':key,'kind':'image','file':'resources/original.png','sha256':digest,'source':{'preserveOriginalBounds':preserve}}
                       for key,preserve in [('reference',True),('ordinary',False)]]
            (root/'asset-preparation.json').write_text(json.dumps({'resources':resources}));prepare(root)
            pinned=json.loads((root/'prepared-resources.json').read_text())
            self.assertEqual((pinned[0]['width'],pinned[0]['height']),(20,30));self.assertEqual(pinned[0]['sha256'],digest)
            self.assertEqual((root/pinned[0]['file']).read_bytes(),original)
            self.assertEqual((pinned[1]['width'],pinned[1]['height']),(10,16));self.assertEqual(pinned[1]['source']['trimmedAlphaBounds'],[5,7,15,23])
            self.assertNotEqual(pinned[1]['sha256'],digest)


if __name__=='__main__':unittest.main()
