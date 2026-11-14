import json
import pathlib
import tempfile
import unittest
from PIL import Image
from crop_reference_renders import crop


class SourceRenderCrops(unittest.TestCase):
    def fixture(self, root, margin, loose=False):
        source=root/'source';collected=root/'collected';source.mkdir();collected.mkdir()
        folder=source/('loose' if loose else 'sections');folder.mkdir()
        # Independently marked corners make a shifted/shrunken crop visibly wrong.
        im=Image.new('RGB',(80+2*margin,60+2*margin),'white')
        for box,color in [((0,0,40,30),'red'),((40,0,80,30),'green'),((0,30,40,60),'blue'),((40,30,80,60),'yellow')]:
            im.paste(color,tuple(v+margin for v in box))
        sid='section';rid='frame';im.save(folder/((rid if loose else sid)+'.png'))
        box={'x':100,'y':200,'width':80,'height':60}
        (source/'resolved-bounds-mcp.json').write_text(json.dumps([{'id':sid,'box':box},{'id':rid,'box':box,'visible':True,'opacity':1}]))
        meta={'id':rid if loose else sid,'original_width':80,'original_height':60,'width':im.width,'height':im.height}
        if not loose:meta['margin']=margin
        (source/'section-renders.json').write_text(json.dumps([] if loose else [meta]))
        if loose:(source/'loose-renders.json').write_text(json.dumps([meta]))
        (collected/'references.json').write_text(json.dumps([{'id':rid,'sectionId':None if loose else sid}]))
        return source,collected,root/'out'

    def test_section_screenshot_native_export_and_loose_frame_preserve_all_corners(self):
        for margin,loose in [(40,False),(0,False),(0,True)]:
            with self.subTest(margin=margin,loose=loose),tempfile.TemporaryDirectory() as temp:
                args=self.fixture(pathlib.Path(temp),margin,loose);row=crop(*args)[0]
                self.assertEqual(row['status'],'cropped-unreviewed')
                im=Image.open(args[2]/row['file']);self.assertEqual(im.size,(80,60))
                self.assertEqual([im.getpixel(p) for p in [(0,0),(79,0),(0,59),(79,59)]],[(255,0,0),(0,128,0),(0,0,255),(255,255,0)])

    def test_bounds_mismatch_cannot_silently_create_a_wrong_evidence_image(self):
        with tempfile.TemporaryDirectory() as temp:
            args=self.fixture(pathlib.Path(temp),40);path=args[0]/'section-renders.json';meta=json.loads(path.read_text());meta[0]['original_width']=120;path.write_text(json.dumps(meta))
            row=crop(*args)[0];self.assertEqual(row['status'],'screenshot-bounds-mismatch');self.assertNotIn('file',row)

    def test_dimmed_source_is_retained_with_explicit_opacity_flag(self):
        with tempfile.TemporaryDirectory() as temp:
            args=self.fixture(pathlib.Path(temp),40);path=args[0]/'resolved-bounds-mcp.json';data=json.loads(path.read_text());data[1]['opacity']=.1;path.write_text(json.dumps(data))
            row=crop(*args)[0];self.assertTrue(row['lowOpacity']);self.assertEqual(row['opacity'],.1)


if __name__=='__main__':unittest.main()
