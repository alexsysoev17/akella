import unittest,pathlib
from PIL import ImageFont
from banner_layout import wrap
class TypographyTests(unittest.TestCase):
 def test_explicit_breaks_and_oversized_words_not_silently_truncated(self):
  font=ImageFont.load_default(size=20)
  self.assertEqual(wrap('One\nTwo',font,300),['One','Two'])
  text='supercalifragilisticexpialidocious'
  self.assertEqual(wrap(text,font,25),[text])
 def test_wrap_retains_every_word(self):
  font=ImageFont.load_default(size=20);text='One two three four five six'
  self.assertEqual(' '.join(wrap(text,font,90)),text)
  self.assertGreater(len(wrap(text,font,90)),1)
