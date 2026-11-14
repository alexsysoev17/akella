"""Install the optional pinned Kiwi decoder from npm; no client data is uploaded."""
import base64
import hashlib
import io
import json
import pathlib
import tarfile
import urllib.request

VERSION='0.5.0'
ROOT=pathlib.Path(__file__).resolve().parents[2]/'data/knowledge/fig-decoder'
if __name__=='__main__':
    metadata=json.load(urllib.request.urlopen('https://registry.npmjs.org/kiwi-schema/'+VERSION,timeout=30))
    url=metadata['dist']['tarball']
    if not url.startswith('https://registry.npmjs.org/kiwi-schema/-/'):raise ValueError('Unexpected registry URL')
    content=urllib.request.urlopen(url,timeout=30).read()
    integrity='sha512-'+base64.b64encode(hashlib.sha512(content).digest()).decode()
    if integrity!=metadata['dist']['integrity']:raise ValueError('Package integrity mismatch')
    ROOT.mkdir(parents=True,exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(content),mode='r:gz') as archive:archive.extractall(ROOT,filter='data')
    (ROOT/'package-manifest.json').write_text(json.dumps({'name':metadata['name'],'version':VERSION,'dist':metadata['dist']},indent=2))
    print('kiwi-schema '+VERSION+' installed; integrity verified')
