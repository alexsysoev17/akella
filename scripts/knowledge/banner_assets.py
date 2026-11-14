"""Pin visible transparent bounds; make an ID-labelled contact sheet for vision input."""
import argparse,hashlib,json,pathlib
from PIL import Image,ImageDraw,ImageFont

def sheet_font(size):
    # The labels contain the source's real names, including Cyrillic.
    for filename in ['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        if pathlib.Path(filename).is_file():return ImageFont.truetype(filename,size)
    return ImageFont.load_default(size=size)

def wrap_label(text,font,width,max_lines=None):
    """Pixel-measured wrapping also breaks long IDs that have no word boundaries."""
    lines=[];line=''
    for word in str(text).split():
        if line and font.getlength(line+' '+word)<=width:
            line+=' '+word;continue
        if line:lines.append(line);line=''
        for char in word:
            if line and font.getlength(line+char)>width:lines.append(line);line=char
            else:line+=char
    if line:lines.append(line)
    if max_lines and len(lines)>max_lines:
        lines=lines[:max_lines]
        while lines[-1] and font.getlength(lines[-1]+'…')>width:lines[-1]=lines[-1][:-1]
        lines[-1]+='…'
    return lines

def render_sheet(root,resources,output,pictures=None):
    """Labels are metadata only; IDs, resources, order and original pixels stay intact."""
    if pictures is None:pictures=[(r,Image.open(root/r['file']).convert('RGBA')) for r in resources if r['kind']=='image']
    width,padding,image_height=250,10,220
    title_font,name_font,id_font=sheet_font(18),sheet_font(14),sheet_font(11)
    labels=[]
    for i,(r,_) in enumerate(pictures):
        r['sheetLabel']=f'A{i+1:02d}'
        labels.append({'sheetLabel':r['sheetLabel'],'id':r['id'],'name':r.get('name',r['id']),
            'nameLines':wrap_label(r.get('name',r['id']),name_font,width-2*padding,2),
            'idLines':wrap_label(r['id'],id_font,width-2*padding)})
    height=max([300]+[image_height+padding+24+len(item['nameLines'])*18+6+len(item['idLines'])*14+padding for item in labels])
    sheet=Image.new('RGB',(1000,height*max(1,(len(pictures)+3)//4)),'#eeeeee')
    for i,((r,im),label) in enumerate(zip(pictures,labels)):
        # Drawing into separate cells makes cross-column/row label overlap impossible.
        cell=Image.new('RGB',(width,height),'#eeeeee');draw=ImageDraw.Draw(cell)
        im.thumbnail((225,image_height));cell.paste(im,((width-im.width)//2,(image_height-im.height)//2),im)
        y=image_height+padding;bounds=[]
        for line,font,line_height in [(label['sheetLabel'],title_font,24)]+[(x,name_font,18) for x in label['nameLines']]+[('',id_font,6)]+[(x,id_font,14) for x in label['idLines']]:
            if line:
                draw.text((padding,y),line,font=font,fill='black',anchor='lt');bounds.append(list(draw.textbbox((padding,y),line,font=font,anchor='lt')))
            y+=line_height
        if any(b[0]<0 or b[1]<0 or b[2]>width or b[3]>height for b in bounds):raise ValueError('Asset label exceeds its own cell: '+r['id'])
        label.update(cell={'x':i%4*width,'y':i//4*height,'width':width,'height':height},textBounds=bounds)
        sheet.paste(cell,(i%4*width,i//4*height))
    output.mkdir(parents=True,exist_ok=True);sheet.save(output/'asset-sheet.png')
    (output/'asset-sheet-labels.json').write_text(json.dumps({'version':1,'labels':labels,'allTextInsideOwnCell':True},ensure_ascii=False,indent=2))

def prepare(directory):
    root=pathlib.Path(directory);resources=json.loads((root/'asset-preparation.json').read_text())['resources']
    pictures=[]
    for r in resources:
        if r['kind']!='image':continue
        src=root/r['file'];image=Image.open(src).convert('RGBA');bbox=image.getchannel('A').getbbox()
        if not bbox:raise ValueError('Empty image '+r['id'])
        if bbox!=(0,0,image.width,image.height) and not r.get('source',{}).get('preserveOriginalBounds',False):
            image=image.crop(bbox);file=root/'resources'/(r['sha256']+'-trim.png');image.save(file)
            r['file']=str(file.relative_to(root));r['source']['trimmedAlphaBounds']=bbox;r['sha256']=hashlib.sha256(file.read_bytes()).hexdigest()
        r['width'],r['height']=image.size;pictures.append((r,image))
    render_sheet(root,resources,root,pictures)
    (root/'prepared-resources.json').write_text(json.dumps(resources,ensure_ascii=False,indent=2))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('directory');parser.add_argument('--sheet-only',action='store_true');parser.add_argument('--output-dir');args=parser.parse_args()
    root=pathlib.Path(args.directory)
    if args.sheet_only:
        if not args.output_dir:parser.error('--sheet-only requires --output-dir; the project artifacts are not rewritten')
        resources=json.loads((root/'prepared-resources.json').read_text());render_sheet(root,resources,pathlib.Path(args.output_dir))
    else:
        if args.output_dir:parser.error('--output-dir is for --sheet-only')
        prepare(root)
