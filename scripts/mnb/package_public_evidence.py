#!/usr/bin/env python3
"""Publish bounded measurement metadata, never history, argv, environment or auth."""
import gzip, hashlib, json, pathlib, shutil

root=pathlib.Path('evidence/20261102T1540Z-baseline')
dest=pathlib.Path(__file__).resolve().parents[2]/'docs/audits/mnb-2026-11-02';dest.mkdir(parents=True,exist_ok=True)
rows=[]
for phase in ['baseline','relevo','fixed']:
    for mode,n in [('idle',60),('inbox',60),('edit-save',60),('diff',60),('sustained',180)]:
        values=[json.loads(l) for l in (root/phase/f'{mode}.jsonl').read_text().splitlines()]
        assert len(values)==n
        rows.extend(values)
for variant in ['original','fixed']:
    values=[json.loads(l) for l in (root/'reversal'/f'{variant}.jsonl').read_text().splitlines()];assert len(values)==70;rows.extend(values)
# Ambient process samples stay in the private local backup.
assert len(rows)==1400
for row in rows:
    for process in row['processes']:
        process['executable']=pathlib.PurePath(process['executable']).name
raw='\n'.join(json.dumps(row,separators=(',',':')) for row in rows)+'\n'
(dest/'process-samples.jsonl.gz').write_bytes(gzip.compress(raw.encode(),mtime=0))
for name in ['metadata.json','ambient-summary.json','native-summary.json','baseline-completion-seal.json','relevo-completion-seal.json','fixed-completion-seal.json','isolated-install-manifest.json','fixed-copy-hashes.json','mac-pr-test-results.json','validation-snapshots.json','native-fileeditor-probe.json','native-editor-source-proof.json','native-inbox-navigation.json','native-exec-probe.json']:
    shutil.copy2(root/name,dest/name)
# Keep only the generic machine label; preserve hardware and software versions.
metadata=json.loads((dest/'metadata.json').read_text())
metadata['host']='test-mac'
(dest/'metadata.json').write_text(json.dumps(metadata,indent=2)+'\n')
# Also remove stale inventory artifacts when repackaging an earlier publication.
for name in ['app-mods.json','tui-plugins.json','personal-main-mod-references.json']:
    (dest/name).unlink(missing_ok=True)
for phase in ['baseline','relevo','fixed']:
    for file in (root/phase).glob('operations-*.json'):
        shutil.copy2(file,dest/f'{phase}-{file.name}')
    if phase!='baseline':shutil.copy2(root/phase/'idle.png',dest/f'{phase}-idle.png')
for name in ['pr-spinner-regression-before.log','pr-spinner-regression-after.log','fixed-native-check.log']:
    text=(root/name).read_text().replace(str(pathlib.Path.cwd()),'<WORKSPACE>')
    (dest/name).write_text('\n'.join(line.rstrip() for line in text.splitlines())+'\n')
manifest={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in dest.iterdir() if p.is_file() and p.name not in ['SHA256SUMS.json','README.md']}
(dest/'SHA256SUMS.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'native_samples':1260,'ambient_samples_published':0,'ambient_samples_private':90,'total_public_samples':1400,'reversal_samples':140,'compressed_bytes':(dest/'process-samples.jsonl.gz').stat().st_size,'public_file_count':len(manifest)}))
