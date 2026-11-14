"""Crop source reference frames from a Figma section render using resolved MCP bounds.

No model-generated pixels. Authored .fig transforms are deliberately not used for this crop.
Figma screenshots include a 40-source-pixel margin; the checked metadata must agree with
the selected section dimensions. Out-of-bounds/hidden/low-opacity refs remain explicit.
"""
import argparse, hashlib, json, math, pathlib
from PIL import Image, ImageDraw, ImageFont

def crop(source, collected, output):
    source, collected, output=map(pathlib.Path,(source,collected,output))
    output.mkdir(parents=True,exist_ok=True)
    refs=json.loads((collected/'references.json').read_text())
    bounds={x['id']:x for x in json.loads((source/'resolved-bounds-mcp.json').read_text())}
    renders={x['id']:x for x in json.loads((source/'section-renders.json').read_text())}
    loose={x['id']:x for x in json.loads((source/'loose-renders.json').read_text())} if (source/'loose-renders.json').exists() else {}
    result=[]; cache={}
    for ref in refs:
        item={'id':ref['id'],'sectionId':ref['sectionId'],'status':'missing-render'}
        own=bounds.get(ref['id']);section=bounds.get(ref['sectionId']);meta=renders.get(ref['sectionId'])
        if not ref['sectionId']:section=own;meta=loose.get(ref['id'])
        if not own or not own.get('box'):item['status']='missing-resolved-bounds'
        elif not own.get('visible',True):item['status']='hidden'
        elif meta and section and section.get('box'):
            render_id=ref['sectionId']or ref['id']
            filename=source/('sections' if ref['sectionId'] else 'loose')/meta.get('file',render_id.replace(':','-')+'.png')
            if filename.exists() and filename.stat().st_size>100:
                if render_id not in cache:cache[render_id]=Image.open(filename).convert('RGB')
                im=cache[render_id];s=section['box'];b=own['box']
                if abs(meta['original_width']-s['width'])>2 or abs(meta['original_height']-s['height'])>2:
                    item['status']='screenshot-bounds-mismatch'
                else:
                    margin=meta.get('margin',40 if ref['sectionId'] else 0)
                    sx=im.width/(math.ceil(s['width'])+2*margin);sy=im.height/(math.ceil(s['height'])+2*margin)
                    box=[round((b['x']-s['x']+margin)*sx),round((b['y']-s['y']+margin)*sy),round((b['x']-s['x']+margin+b['width'])*sx),round((b['y']-s['y']+margin+b['height'])*sy)]
                    if box[0]<0 or box[1]<0 or box[2]>im.width or box[3]>im.height or box[2]<=box[0] or box[3]<=box[1]:item['status']='outside-section-render'
                    else:
                        target=output/(ref['id'].replace(':','-')+'.png');im.crop(box).save(target)
                        item.update(status='cropped-unreviewed',file=target.name,sha256=hashlib.sha256(target.read_bytes()).hexdigest(),
                            width=box[2]-box[0],height=box[3]-box[1],sourceSection=ref['sectionId'],sourcePixels=box,
                            coordinateAuthority='Figma MCP absoluteBoundingBox',opacity=own.get('opacity',1),
                            lowOpacity=own.get('opacity',1)<.75)
        result.append(item)
    (output/'manifest.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
    return result

def contacts(output, collected, columns=6, page_size=36):
    output,collected=map(pathlib.Path,(output,collected))
    refs={x['id']:x for x in json.loads((collected/'references.json').read_text())}
    rows=json.loads((output/'manifest.json').read_text());groups={}
    for row in rows:
        if row.get('file'):groups.setdefault(row['sectionId']or'loose',[]).append(row)
    dest=output/'contacts';dest.mkdir(exist_ok=True)
    try:font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',14)
    except OSError:font=ImageFont.load_default()
    for group,members in groups.items():
        for page in range(0,len(members),page_size):
            part=members[page:page+page_size];sheet=Image.new('RGB',(columns*300,math.ceil(len(part)/columns)*250),'#444444');draw=ImageDraw.Draw(sheet)
            for i,row in enumerate(part):
                x=(i%columns)*300;y=(i//columns)*250;im=Image.open(output/row['file']).convert('RGB');im.thumbnail((286,212));sheet.paste(im,(x+(300-im.width)//2,y+(212-im.height)//2))
                label=row['id']+' '+str(round(refs[row['id']]['width']))+'x'+str(round(refs[row['id']]['height']))
                if row.get('lowOpacity'):label+=' [dimmed]'
                draw.text((x+5,y+214),label,fill='white',font=font)
                draw.text((x+5,y+232),refs[row['id']]['name'][:34],fill='#dddddd',font=font)
            sheet.save(dest/(group.replace(':','-')+'-'+str(page//page_size+1)+'.jpg'),quality=92)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source');p.add_argument('collected');p.add_argument('output');a=p.parse_args()
    rows=crop(a.source,a.collected,a.output);contacts(a.output,a.collected)
    from collections import Counter
    print(json.dumps(dict(Counter(x['status']for x in rows))))
