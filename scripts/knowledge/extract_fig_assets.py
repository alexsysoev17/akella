"""Extract inventoried image fills from an authorized local .fig copy.

The inventory comes from Figma node inspection; matching is by image hash, never by
filename similarity. This collects bytes and metadata only and does not mark them reviewed.
"""
import argparse
import hashlib
import io
import json
import pathlib
import re
import zipfile
from PIL import Image


def extract(archive, inventory, output):
    output = pathlib.Path(output)
    output.mkdir(parents=True, exist_ok=True)
    source = json.loads(pathlib.Path(inventory).read_text())
    nodes = source['assetNodes']
    results = []
    with zipfile.ZipFile(archive) as bundle:
        for name in ['canvas.fig','meta.json']:
            if name in bundle.namelist():
                if bundle.getinfo(name).file_size>128*1024*1024:raise ValueError('Oversized source document')
                (output/name).write_bytes(bundle.read(name))
        for node in nodes:
            digest = node['imageHash']
            if not re.fullmatch(r'[0-9a-f]{40}', digest):
                raise ValueError('Invalid image hash')
            entry = 'images/' + digest
            if entry not in bundle.namelist():
                results.append({'id': node['id'], 'imageHash': digest, 'status': 'missing'})
                continue
            if bundle.getinfo(entry).file_size > 128 * 1024 * 1024:
                raise ValueError('Image exceeds extraction limit')
            content = bundle.read(entry)
            if hashlib.sha1(content).hexdigest() != digest:
                raise ValueError('Figma image hash does not match bytes')
            image = Image.open(io.BytesIO(content))
            extension = {'PNG': '.png', 'JPEG': '.jpg', 'WEBP': '.webp', 'GIF': '.gif'}.get(image.format)
            if not extension:
                raise ValueError('Unsupported source image format')
            filename = digest + extension
            (output / filename).write_bytes(content)
            image.load()
            results.append({**node, 'status': 'downloaded-unreviewed', 'file': filename,
                            'sha256': hashlib.sha256(content).hexdigest(),
                            'pixelWidth': image.width, 'pixelHeight': image.height,
                            'alpha': image.convert('RGBA').getchannel('A').getextrema()[0]<255,
                            'source': 'local-fig-image-fill'})
    (output / 'manifest.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    return {'expected': len(nodes), 'extracted': sum(x['status'] != 'missing' for x in results)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('inventory')
    parser.add_argument('output')
    args = parser.parse_args()
    print(json.dumps(extract(args.archive, args.inventory, args.output)))
