"""Retain source geometry for explicitly selected pages; no automatic brand rules.

Raw numeric values describe source nodes. Instances retain authored fields; this is
not a Figma renderer or a complete resolver for component overrides/variables.
"""
import argparse
import functools
import json
import pathlib


def normalize(document, pages):
    nodes=document['nodeChanges']
    def guid(g):return f"{g['sessionID']}:{g['localID']}" if g else None
    by={guid(n['guid']):n for n in nodes}
    if len(by)!=len(nodes) or any(n.get('phase')!='CREATED' for n in nodes):
        raise ValueError('Only complete snapshots with unique nodes are supported')
    for page in pages:
        if by.get(page,{}).get('type')!='CANVAS':raise ValueError('Missing page '+page)
    @functools.lru_cache(None)
    def ancestry(id):
        n=by[id];parent=guid(n.get('parentIndex',{}).get('guid'))
        chain=ancestry(parent) if parent in by else ()
        return chain+(id,)
    keys={'name','type','visible','opacity','size','transform','cornerRadius','cornerSmoothing',
          'rectangleTopLeftCornerRadius','rectangleTopRightCornerRadius','rectangleBottomLeftCornerRadius',
          'rectangleBottomRightCornerRadius','fontName','fontSize','lineHeight','letterSpacing','textData',
          'fillPaints','strokePaints','strokeWeight','effects','layoutGrids','guides','frameMaskDisabled',
          'textAlignHorizontal','textAlignVertical','textAutoResize','textTracking','textCase',
          'textDecoration','paragraphSpacing','listSpacing'}
    result=[]
    for id,n in by.items():
        chain=ancestry(id);page=next((x for x in chain if x in pages),None)
        if not page:continue
        record={k:v for k,v in n.items() if k in keys or k.startswith('stack')}
        record.update(id=id,parentId=guid(n.get('parentIndex',{}).get('guid')),pageId=page,
                      ancestorIds=list(chain[:-1]),effectiveVisible=all(by[x].get('visible',True) and by[x].get('opacity',1)>0 for x in chain),
                      sourcePosition=n.get('parentIndex',{}).get('position'))
        result.append(record)
    return {'schema':'fig-source-geometry/1','pages':pages,'nodes':result,
            'limits':['Source-local matrices and authored values; not resolved component/variable rendering',
                      'Measurements of a reference are observations, never automatically global design tokens']}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('decoded');p.add_argument('output');p.add_argument('pages',nargs='+');a=p.parse_args()
    result=normalize(json.loads(pathlib.Path(a.decoded).read_text()),a.pages)
    pathlib.Path(a.output).write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps({'nodes':len(result['nodes']),'visible':sum(n['effectiveVisible'] for n in result['nodes'])}))
