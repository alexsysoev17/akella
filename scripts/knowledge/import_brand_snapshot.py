"""Import a reviewed portable evidence bundle, then atomically activate its catalog.

Bundle: source.json (nodeIds), records.json, coverage.json, referenced media/files.
Collectors/reviewers supply this schema for Figma, PDF or other sources. Extraction
is not approval. The active snapshot remains readable while a new one builds.
"""
import argparse
import json
import pathlib
import shutil
import tempfile
import uuid

from brand_library import ROOT, build, collection, local, validate


def ingest(brand, bundle, name, root=ROOT, embed=False):
    bundle = pathlib.Path(bundle).resolve()
    source = json.loads(local(bundle, 'source.json').read_text())
    records = json.loads(local(bundle, 'records.json').read_text())
    coverage = json.loads(local(bundle, 'coverage.json').read_text())
    resources = json.loads(local(bundle, 'resources.json').read_text()) if (bundle/'resources.json').exists() else []
    authoring = json.loads(local(bundle, 'authoring.json').read_text()) if (bundle/'authoring.json').exists() else None
    if authoring:
        if authoring.get('version')!=1:raise ValueError('Unsupported authoring profile')
        if any(i not in {r['id'] for r in records} for i in authoring.get('requiredEvidence',[])):raise ValueError('Unknown authoring evidence')
        combined={r['id']:r for r in resources}
        for r in authoring['resources']:
            if r['id'] in combined and r!=combined[r['id']]:raise ValueError('Conflicting authoring resource')
            combined[r['id']]=r
        resources=list(combined.values())
    files = {'source.json', 'records.json', 'coverage.json'}
    files.update(r['file'] for r in resources)
    for record in records:
        validate(record, source, bundle)
        for evidence in record['evidence']:
            files.update(evidence[key] for key in ['image', 'file'] if key in evidence)
        if record.get('media'):
            files.add(record['media']['file'])
        if record.get('geometry'):
            files.add(record['geometry']['file'])

    base = collection(brand, root)
    base.mkdir(parents=True, exist_ok=True)
    snapshot = 'snapshots/' + str(uuid.uuid4())
    catalog = {
        'brand': brand, 'name': name, 'snapshot': snapshot,
        'source': snapshot + '/source.json', 'records': snapshot + '/records.json',
        'index': snapshot + '/index.sqlite', 'coverage': coverage,
        'resources': [{**r, 'file': snapshot + '/' + str(local(bundle,r['file']).relative_to(bundle))} for r in resources],
    }
    if authoring:catalog['authoring']=snapshot+'/authoring.json'
    # Build in a separate brand root with identical relative paths. Neither the
    # active catalog nor index is touched until all evidence and vectors are valid.
    with tempfile.TemporaryDirectory(dir=base, prefix='.import-') as tmp:
        staging_root = pathlib.Path(tmp)
        staging_brand = staging_root / brand
        stage = staging_brand / snapshot
        stage.mkdir(parents=True)
        for filename in files:
            src = local(bundle, filename)
            target = stage / src.relative_to(bundle)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, target)
        for record in records:
            for evidence in record['evidence']:
                for key in ['file', 'image']:
                    if key in evidence:
                        evidence[key] = snapshot + '/' + str(local(bundle, evidence[key]).relative_to(bundle))
            if record.get('media'):
                record['media']['file'] = snapshot + '/' + str(local(bundle, record['media']['file']).relative_to(bundle))
            if record.get('geometry'):
                record['geometry']['file'] = snapshot + '/' + str(local(bundle, record['geometry']['file']).relative_to(bundle))
        (stage / 'records.json').write_text(json.dumps(records, ensure_ascii=False, indent=2))
        if authoring:
            authoring['snapshot']=catalog['snapshot']
            authoring['resources']=[{**r,'file':snapshot+'/'+str(local(bundle,r['file']).relative_to(bundle))} for r in authoring['resources']]
            (stage/'authoring.json').write_text(json.dumps(authoring,ensure_ascii=False,indent=2))
        staged_catalog = staging_brand / 'catalog.json'
        staged_catalog.write_text(json.dumps(catalog, ensure_ascii=False, indent=2))
        result = build(brand, staging_root, embed)
        destination = base / snapshot
        destination.parent.mkdir(exist_ok=True)
        shutil.move(str(stage), destination)
        staged_catalog.replace(base / 'catalog.json')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('brand')
    parser.add_argument('bundle')
    parser.add_argument('--name', required=True)
    parser.add_argument('--embed', action='store_true')
    args = parser.parse_args()
    print(json.dumps(ingest(args.brand, args.bundle, args.name, embed=args.embed), ensure_ascii=False))
