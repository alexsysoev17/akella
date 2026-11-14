import struct
import unittest
from font_matching import normalized_weight,checksum

def fixture(weight=511,variable=False):
    tables={b'OS/2':struct.pack('>HHH',0,600,weight)+b'\0'*26,b'head':b'\0'*54,b'glyf':b'unchanged glyph outlines'}
    if variable:tables[b'fvar']=b'variable font axes'
    data=bytearray(struct.pack('>IHHHH',0x10000,len(tables),0,0,0)+b'\0'*(16*len(tables)))
    for i,(tag,body) in enumerate(tables.items()):
        offset=len(data);data+=body+b'\0'*((-len(body))%4)
        struct.pack_into('>4sIII',data,12+16*i,tag,checksum(body),offset,len(body))
    return bytes(data)

class FontMatchingTests(unittest.TestCase):
    def test_weight_only_preserves_glyphs_and_validates_sfnt_checksum(self):
        data=fixture();copy,changed=normalized_weight(data,500)
        self.assertTrue(changed);self.assertEqual(checksum(copy),0xB1B0AFBA)
        self.assertIn(b'unchanged glyph outlines',copy)
        entry=struct.unpack_from('>4sIII',copy,12)
        self.assertEqual(struct.unpack_from('>H',copy,entry[2]+4)[0],500)
        self.assertEqual(entry[1],checksum(copy[entry[2]:entry[2]+entry[3]]))
        self.assertEqual(struct.unpack_from('>H',data,entry[2]+4)[0],511)
        self.assertEqual(normalized_weight(copy,500),(copy,False))
    def test_variable_and_unsupported_containers_are_not_rewritten(self):
        for data in [fixture(variable=True),b'ttcf collection']:
            self.assertEqual(normalized_weight(data,500),(data,False))
    def test_truncated_table_rejected(self):
        with self.assertRaisesRegex(ValueError,'Truncated'):normalized_weight(fixture()[:-20],500)

if __name__=='__main__':unittest.main()
