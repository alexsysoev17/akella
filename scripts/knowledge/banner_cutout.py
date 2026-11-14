"""Local alpha extraction for isolated generated KVs, never for photographic scenes.
U-2-Net: https://github.com/xuebinqin/U-2-Net (Apache-2.0).
ONNX release / preprocessing reference: https://github.com/danielgatis/rembg (MIT).
Weights are an explicit optional setup download, not downloaded during a render.
"""
import argparse,hashlib,json,pathlib,urllib.request
import numpy as np
from PIL import Image,ImageOps
MODEL=pathlib.Path(__file__).resolve().parents[2]/'data/knowledge/banner-models/u2net.onnx'
URL='https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx'
MD5='60024c5c889badc19c04ad937298a77b'
def setup():
    MODEL.parent.mkdir(parents=True,exist_ok=True)
    if not MODEL.exists():
        temporary=MODEL.with_suffix('.download')
        with urllib.request.urlopen(URL,timeout=60) as response,temporary.open('wb') as out:
            while chunk:=response.read(1024*1024):out.write(chunk)
        if hashlib.md5(temporary.read_bytes()).hexdigest()!=MD5:raise ValueError('Model checksum mismatch')
        temporary.replace(MODEL)
    if hashlib.md5(MODEL.read_bytes()).hexdigest()!=MD5:raise ValueError('Model checksum mismatch')
    return {'model':'u2net','sha256':hashlib.sha256(MODEL.read_bytes()).hexdigest()}
def cutout(source,output):
    image=ImageOps.exif_transpose(Image.open(source)).convert('RGBA')
    if image.width*image.height>20_000_000:raise ValueError('KV exceeds 20 megapixels')
    if image.getchannel('A').getextrema()[0]==255:
        if not MODEL.exists():raise ValueError('Run scripts/knowledge/banner_cutout.py --setup for isolated KV background removal')
        if hashlib.md5(MODEL.read_bytes()).hexdigest()!=MD5:raise ValueError('Model checksum mismatch')
        import onnxruntime as ort
        options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
        session=ort.InferenceSession(str(MODEL),sess_options=options,providers=['CPUExecutionProvider'])
        pixels=np.asarray(image.convert('RGB').resize((320,320),Image.Resampling.LANCZOS),dtype=np.float32)
        pixels/=max(float(pixels.max()),1)
        pixels=(pixels-np.array([.485,.456,.406],dtype=np.float32))/np.array([.229,.224,.225],dtype=np.float32)
        prediction=session.run(None,{session.get_inputs()[0].name:pixels.transpose(2,0,1)[None]})[0][0,0]
        span=float(prediction.max()-prediction.min())
        if span<1e-6:raise ValueError('No foreground found')
        alpha=Image.fromarray(np.uint8(np.clip((prediction-prediction.min())/span,0,1)*255)).resize(image.size,Image.Resampling.LANCZOS)
        image.putalpha(alpha)
    bbox=image.getchannel('A').point(lambda x:255 if x>3 else 0).getbbox()
    if not bbox:raise ValueError('Empty foreground')
    image=image.crop(bbox);image.save(output)
    return {'width':image.width,'height':image.height,'alpha':image.getchannel('A').getextrema(),'method':'u2net-or-preserved-alpha','sha256':hashlib.sha256(pathlib.Path(output).read_bytes()).hexdigest()}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--setup',action='store_true');p.add_argument('source',nargs='?');p.add_argument('output',nargs='?');a=p.parse_args()
    print(json.dumps(setup() if a.setup else cutout(a.source,a.output)))
