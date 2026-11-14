import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest

from collect_motion_references import FFMPEG, collect


class MotionCollectionTest(unittest.TestCase):
    def test_real_frames_have_original_pts_and_never_become_approved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source'
            source.mkdir()
            clip = source / 'original.mp4'
            subprocess.run([str(FFMPEG), '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
                            '-i', 'testsrc2=size=128x96:rate=8', '-t', '2', '-c:v', 'libx264',
                            '-pix_fmt', 'yuv420p', str(clip)], check=True, timeout=30)
            original = hashlib.sha256(clip.read_bytes()).hexdigest()
            result = collect(source, root / 'evidence', sample_fps=2,
                             windows=[{'file': clip.name, 'start': .25, 'end': .75, 'fps': 4}])
            self.assertEqual(result['status'], 'completed')
            record = result['records'][0]
            self.assertEqual(record['overview']['timestampsSeconds'], [0, .5, 1, 1.5])
            self.assertEqual(record['windows'][0]['timestampsSeconds'], [.25, .5, .75])
            self.assertEqual(record['reviewStatus'], 'NOT_REVIEWED')
            self.assertEqual(record['patterns'], [])
            self.assertEqual(record['originalSha256'], original)
            self.assertEqual(hashlib.sha256(clip.read_bytes()).hexdigest(), original)
            self.assertEqual(list(source.iterdir()), [clip])
            self.assertTrue(record['overview']['contactSheets'][0]['sha256'])
            with self.assertRaises(FileExistsError):
                collect(source, root / 'evidence')
            with self.assertRaises(ValueError):
                collect(source, source / 'must-not-write')
            limited = collect(source, root / 'limited', sample_fps=8, max_frames=3)
            self.assertEqual(limited['status'], 'completed')
            self.assertEqual(limited['records'][0]['overview']['timestampsSeconds'], [0, .125, .25])
            self.assertTrue(limited['records'][0]['overview']['possiblyTruncatedAtFrameLimit'])


if __name__ == '__main__':
    unittest.main()
