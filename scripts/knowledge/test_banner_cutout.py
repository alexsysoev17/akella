import pathlib,tempfile,unittest
from unittest.mock import patch
from PIL import Image
from banner_cutout import cutout

class CutoutTests(unittest.TestCase):
 def test_existing_alpha_preserved_without_model_and_only_empty_bounds_trimmed(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);source=root/'input.png';out=root/'out.png'
   image=Image.new('RGBA',(20,30),(0,0,0,0));image.paste((200,40,10,128),(5,6,15,25));image.save(source)
   with patch('banner_cutout.MODEL',root/'missing.onnx'):report=cutout(source,out)
   result=Image.open(out)
   self.assertEqual(result.size,(10,19));self.assertEqual(result.getpixel((5,5)),(200,40,10,128));self.assertEqual(report['alpha'],(128,128))
