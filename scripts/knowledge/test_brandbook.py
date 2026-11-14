import unittest
from brandbook import chunks

class CorpusTests(unittest.TestCase):
    def fixture(self,text='Rule'):
        return {'fileKey':'test','frames':[{'id':'1:1','texts':[{'id':'2:1','text':text,'visible':True},{'id':'2:2','text':'Hidden rule','visible':False}]}]}
    def test_hidden_rules_and_sources(self):
        items=chunks(self.fixture())
        self.assertEqual(len(items),1);self.assertEqual(items[0]['nodeIds'],['2:1'])
        self.assertNotIn('Hidden',items[0]['text']);self.assertIn('node-id=1-1',items[0]['url'])
    def test_long_text_is_not_lost(self):
        text=''.join(chr(0x400+i%200) for i in range(5000))
        items=chunks(self.fixture(text))
        self.assertGreater(len(items),1)
        for i in range(0,len(text),700):self.assertTrue(any(text[i:i+800] in x['text'] for x in items))
    def test_stable_content_identity_and_update(self):
        self.assertEqual(chunks(self.fixture()),chunks(self.fixture()))
        self.assertNotEqual(chunks(self.fixture())[0]['id'],chunks(self.fixture('Changed'))[0]['id'])
if __name__=='__main__':unittest.main()
