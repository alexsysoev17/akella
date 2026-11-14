"""Measure real glyphs and serialize a bounded, editable SVG document.

The server supplies pinned resource paths. No model-authored SVG/XML/code executes.
Optional appearance fields extend v1; missing appearance retains legacy rendering.
Blur parameters are radii in pixels (SVG Gaussian sigma = radius / 2).
"""
import base64
import html
import json
import math
import pathlib
import sys
import xml.etree.ElementTree as ET
from PIL import Image, ImageFont
from font_matching import native_font_files, WEIGHTS


def esc(value):
    return html.escape(str(value), quote=True)


def measure(text, font, spacing=0):
    return font.getlength(text) + max(0, len(text)-1)*spacing


def wrap(text, font, width, spacing=0):
    lines = []
    for paragraph in text.split('\n'):
        current = ''
        for word in paragraph.split(' '):
            candidate = (current+' '+word).lstrip()
            if current and measure(candidate, font, spacing) > width:
                lines.append(current)
                current = word
            else:
                current = candidate
        lines.append(current)
    return lines


def gradient(definitions, name, paint):
    stops = ''.join(f'<stop offset="{s["offset"]}" stop-color="{s["color"]}" stop-opacity="{s["opacity"]}"/>' for s in paint['stops'])
    start, end = paint['from'], paint['to']
    if paint['type'] == 'linear':
        definitions.append(f'<linearGradient id="{name}" x1="{start["x"]}" y1="{start["y"]}" x2="{end["x"]}" y2="{end["y"]}">{stops}</linearGradient>')
    else:
        # Centered radial fills need only a center and extent. `to` belongs to
        # linear fills; interpreting it as an SVG focus can collapse the fill
        # when an agent places that point outside the radial circle.
        definitions.append(f'<radialGradient id="{name}" cx="{start["x"]}" cy="{start["y"]}" r="{paint["radius"]}">{stops}</radialGradient>')
    return f'url(#{name})'


def effect_filter(definitions, name, layer, appearance):
    shadow = appearance.get('shadow')
    blur = appearance.get('blur', 0)
    if not shadow and not blur:
        return ''
    # Explicit region keeps a soft shadow from being clipped at its layer's bounds.
    radius = blur + (shadow['blur'] if shadow else 0)
    offset = max(abs(shadow['offsetX']), abs(shadow['offsetY'])) if shadow else 0
    padding = math.ceil(radius*1.5 + offset + (appearance.get('stroke') or {}).get('width', 0) + 2)
    body = []
    source = 'SourceGraphic'
    if shadow:
        body += [f'<feGaussianBlur in="SourceAlpha" stdDeviation="{shadow["blur"]/2}" result="shadowBlur"/>',
                 f'<feOffset in="shadowBlur" dx="{shadow["offsetX"]}" dy="{shadow["offsetY"]}" result="shadowOffset"/>',
                 f'<feFlood flood-color="{shadow["color"]}" flood-opacity="{shadow["opacity"]}" result="shadowColor"/>',
                 '<feComposite in="shadowColor" in2="shadowOffset" operator="in" result="shadowPaint"/>',
                 '<feMerge result="withShadow"><feMergeNode in="shadowPaint"/><feMergeNode in="SourceGraphic"/></feMerge>']
        source = 'withShadow'
    if blur:
        body.append(f'<feGaussianBlur in="{source}" stdDeviation="{blur/2}"/>')
    definitions.append(f'<filter id="{name}" filterUnits="userSpaceOnUse" x="{layer["x"]-padding}" y="{layer["y"]-padding}" width="{layer["width"]+2*padding}" height="{layer["height"]+2*padding}" color-interpolation-filters="sRGB">'+''.join(body)+'</filter>')
    return f' filter="url(#{name})"'


def image_size(resource):
    if resource.get('width') and resource.get('height'):
        return resource['width'], resource['height']
    source = pathlib.Path(resource['absoluteFile'])
    if source.suffix.lower() == '.svg':
        root = ET.fromstring(source.read_bytes())
        view_box = root.attrib.get('viewBox', '').replace(',', ' ').split()
        if len(view_box) == 4:
            return float(view_box[2]), float(view_box[3])
        return float(root.attrib['width'].removesuffix('px')), float(root.attrib['height'].removesuffix('px'))
    with Image.open(source) as image:
        return image.size


def image_element(layer, resource, appearance, name, definitions, uri):
    x, y, w, h = layer['x'], layer['y'], layer['width'], layer['height']
    if not appearance:
        return f'<image x="{x}" y="{y}" width="{w}" height="{h}" preserveAspectRatio="xMidYMid meet" xlink:href="{uri}"/>'
    sw, sh = image_size(resource)
    scale = max(w/sw, h/sh) if appearance['imageFit'] == 'cover' else min(w/sw, h/sh)
    iw, ih = sw*scale, sh*scale
    ix, iy = x+(w-iw)*appearance['imagePosition']['x'], y+(h-ih)*appearance['imagePosition']['y']
    radius = min(layer['radius'], w/2, h/2)
    clip = ''
    if radius or appearance['imageFit'] == 'cover':
        definitions.append(f'<clipPath id="{name}" clipPathUnits="userSpaceOnUse"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}"/></clipPath>')
        clip = f' clip-path="url(#{name})"'
    image = f'<image x="{ix}" y="{iy}" width="{iw}" height="{ih}" preserveAspectRatio="none" xlink:href="{uri}"/>'
    return f'<g{clip}>{image}</g>'


def layout(request):
    variant = request['variant']
    resources = {r['id']: r for r in request['resources']}
    definitions, parts, styles = [], [], []
    for resource in resources.values():
        if resource['kind'] == 'font':
            weight = WEIGHTS.get(resource.get('style'), 400)
            data = base64.b64encode(pathlib.Path(resource['absoluteFile']).read_bytes()).decode()
            styles.append(f'@font-face{{font-family:"{esc(resource["family"])}";font-weight:{weight};src:url(data:font/ttf;base64,{data})}}')
    definitions.append('<style>'+''.join(styles)+'</style>')
    parts.append(f'<rect width="100%" height="100%" fill="{variant["background"]}"/>')
    issues, boxes, cached_images, cached_fonts = [], [], {}, {}
    for index, layer in enumerate(variant['layers']):
        x, y, w, h = layer['x'], layer['y'], layer['width'], layer['height']
        appearance = layer.get('appearance')
        paint = layer['color']
        stroke, effect, spacing = '', '', 0
        if appearance:
            if appearance['fill'] and layer['kind'] in ['text', 'shape']:
                paint = gradient(definitions, f'paint-{index}', appearance['fill'])
            if appearance['stroke']:
                s = appearance['stroke']
                stroke = f' stroke="{s["color"]}" stroke-width="{s["width"]}" stroke-opacity="{s["opacity"]}" stroke-linejoin="round"'
            effect = effect_filter(definitions, f'effect-{index}', layer, appearance)
            spacing = appearance['letterSpacing']
        parts.append(f'<g id="{esc(layer["id"])}" data-name="{esc(layer["name"])}" opacity="{layer["opacity"]}" transform="rotate({layer["rotation"]} {x+w/2} {y+h/2})"{effect}>')
        if layer['kind'] == 'text':
            resource = resources[layer['fontId']]
            font_key = (resource['absoluteFile'], round(layer['fontSize']))
            if font_key not in cached_fonts:
                cached_fonts[font_key] = ImageFont.truetype(*font_key)
            font = cached_fonts[font_key]
            lines = wrap(layer['text'], font, w, spacing)
            line_height = layer['fontSize']*layer['lineHeight']
            top = font.getbbox('Аg', anchor='ls')[1]
            bottom, max_width = 0, 0
            ink_boxes=[]
            for line_index, line in enumerate(lines):
                width = measure(line, font, spacing)
                max_width = max(max_width, width)
                baseline = y-top+line_index*line_height
                xx = x+(w-width)/2 if layer['align'] == 'center' else x+w-width if layer['align'] == 'right' else x
                if line.strip():
                    left,ink_top,right,ink_bottom=font.getbbox(line,anchor='ls')
                    ink_boxes.append({'x':xx+left,'y':baseline+ink_top,'width':right-left+max(0,len(line)-1)*spacing,'height':ink_bottom-ink_top})
                bottom = max(bottom, baseline+font.getbbox(line or ' ', anchor='ls')[3]-y)
                weight = WEIGHTS.get(resource.get('style'), 400)
                tracking = f' letter-spacing="{spacing}"' if spacing else ''
                parts.append(f'<text x="{xx}" y="{baseline}" font-family="{esc(resource["family"])}" font-weight="{weight}" font-size="{round(layer["fontSize"])}" fill="{paint}"{stroke}{tracking} xml:space="preserve">{esc(line)}</text>')
            if max_width > w+.5 or bottom > h+.5:
                issues.append(f'{layer["id"]}: текст не помещается ({round(max_width)}×{round(bottom)} в {round(w)}×{round(h)})')
            ink=None
            if ink_boxes:
                left=min(b['x'] for b in ink_boxes);top=min(b['y'] for b in ink_boxes)
                ink={'x':left,'y':top,'width':max(b['x']+b['width'] for b in ink_boxes)-left,'height':max(b['y']+b['height'] for b in ink_boxes)-top}
            boxes.append({'id': layer['id'], 'width': max_width, 'height': bottom, 'lines': lines,
                'inkBounds':ink,'lineInkBounds':ink_boxes,'boundsSpace':'canvas before layer rotation; original face glyph metrics'})
        elif layer['kind'] in ['image', 'logo']:
            resource = resources[layer['assetId']]
            source = pathlib.Path(resource['absoluteFile'])
            if resource['id'] not in cached_images:
                mime = {'.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}[source.suffix.lower()]
                data = base64.b64encode(source.read_bytes()).decode()
                cached_images[resource['id']] = f'data:{mime};base64,{data}'
            parts.append(image_element(layer, resource, appearance, f'clip-{index}', definitions, cached_images[resource['id']]))
            if stroke:
                parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{min(layer["radius"],w/2,h/2)}" fill="none"{stroke}/>')
        elif layer['shape'] == 'ellipse':
            parts.append(f'<ellipse cx="{x+w/2}" cy="{y+h/2}" rx="{w/2}" ry="{h/2}" fill="{paint}"{stroke}/>')
        elif layer['shape'] == 'path':
            contour = appearance['path']
            # Nested viewport scales authored path coordinates without distorting stroke width.
            parts.append(f'<svg x="{x}" y="{y}" width="{w}" height="{h}" viewBox="0 0 {contour["width"]} {contour["height"]}" preserveAspectRatio="none" overflow="visible"><path d="{esc(contour["data"])}" fill="{paint}"{stroke} vector-effect="non-scaling-stroke"/></svg>')
        else:
            parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{min(layer["radius"],w/2,h/2)}" fill="{paint}"{stroke}/>')
        parts.append('</g>')
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{variant["width"]}" height="{variant["height"]}" viewBox="0 0 {variant["width"]} {variant["height"]}"><defs>'+''.join(definitions)+'</defs>'+''.join(parts)+'</svg>'
    return svg, {'issues': issues, 'textBoxes': boxes}


if __name__ == '__main__':
    source = pathlib.Path(sys.argv[1])
    request=json.loads(source.read_text())
    svg, report = layout(request)
    report['nativeFontFiles'],report['fontMatching']=native_font_files(request,source.parent/'native-fonts')
    source.with_suffix('.svg').write_text(svg)
    source.with_suffix('.metrics.json').write_text(json.dumps(report, ensure_ascii=False))
    print(json.dumps(report, ensure_ascii=False))
