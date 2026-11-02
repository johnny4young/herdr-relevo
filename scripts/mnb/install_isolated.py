#!/usr/bin/env python3
"""Non-overwriting fixture installation; refuses to run before a completed baseline."""
import argparse, datetime, hashlib, json, pathlib, shutil, subprocess

p=argparse.ArgumentParser();p.add_argument('--profile',type=pathlib.Path,required=True);p.add_argument('--baseline',type=pathlib.Path,required=True);a=p.parse_args()
root=a.profile.resolve();app=root/'app';home=root/'home'
proof=json.loads((root/'isolation-proof.json').read_text())
assert pathlib.Path(proof['appHome']).resolve()==app and pathlib.Path(proof['home']).resolve()==home
assert str(root).startswith('/private/tmp/') or str(root).startswith('/tmp/')
for mode,n in [('idle',60),('inbox',60),('edit-save',60),('diff',60),('sustained',180)]:
    samples=[json.loads(s) for s in (a.baseline/f'{mode}.jsonl').read_text().splitlines()]
    assert len(samples)==n and all(any(v['group']=='herdr_gui' for v in s['processes']) for s in samples)
assert json.loads((a.baseline.parent/'baseline-run.log').read_text().splitlines()[-1])['event']=='phase-complete'
cwd=pathlib.Path.cwd();repo=cwd/'herdr-relevo'
sources=[(repo/'mods'/m,m) for m in ['relevo','relevo-agents','relevo-files']]+[(cwd/'herdr-space-folders/mods/space-folders','space-folders'),(cwd/'herdr-issues/mods/issues','issues')]
destinations=[app/'mods'/name for _,name in sources]+[app/'layouts/relevo.json']
assert not any(d.exists() for d in destinations),'Refuse to overwrite an installed mod/layout'
manifest={'installed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'isolated fixture only','source_heads':{},'files':{}}
for directory in [repo,cwd/'herdr-space-folders',cwd/'herdr-issues']:
    manifest['source_heads'][directory.name]=subprocess.check_output(['git','-C',str(directory),'rev-parse','HEAD'],text=True).strip()
for source,name in sources:
    shutil.copytree(source,app/'mods'/name)
shutil.copy2(repo/'layouts/relevo.json',app/'layouts/relevo.json')
# Explicit external-service fixture adapter: never touch Keychain, auth.json or the network.
quota=app/'mods/relevo/quota.js'
manifest['original_quota_sha256']=hashlib.sha256(quota.read_bytes()).hexdigest()
quota.write_text('// Measurement fixture adapter. Production collector is unchanged in Git.\nexport async function collectQuotas() { return {}; }\n')
(app/'mods/relevo/config.js').write_text('''export const ACCOUNTS = [{key:"fixture",label:"Fixture",letter:"F",launcher:"false",claudeDir:".mnb-fixture-claude",bg:"#c3e88d",fg:"#1e2030"}];
export const CODEX = {key:"codex",label:"Codex fixture",letter:"X",launcher:"false",bg:"#4fd6be",fg:"#1e2030"};
export const CONTEXTS = [{key:"fixture",label:"Fixture",account:"fixture",color:"ansi2"}];
export const FALLBACK = ["fixture"];
export const REPOS_ROOT = "code";
export const SKILLS = {review:"review",fix:"fix-ci",comments:"address-comments"};
''')
cache=home/'.cache/herdr-relevo';cache.mkdir(parents=True,exist_ok=True)
now=int(datetime.datetime.now(datetime.timezone.utc).timestamp())
for key in ['fixture','codex']:
    (cache/f'quota-{key}.json').write_text(json.dumps({'updated':now,'rate_limits':{'five_hour':{'used_percentage':12,'resets_at':now+18000},'seven_day':{'used_percentage':8,'resets_at':now+604800}}}))
keys=json.loads((app/'keys.json').read_text());conflicts=[]
for section,bindings in json.loads((repo/'keys.json').read_text()).items():
    target=keys.setdefault(section,{})
    for key,value in bindings.items():
        if key in target and target[key]!=value:conflicts.append({'section':section,'key':key,'kept':target[key],'skipped':value})
        else:target[key]=value
(app/'keys.json').write_text(json.dumps(keys,indent=2));manifest['key_conflicts_kept']=conflicts
def walk(node,mode):
    if node.get('content',{}).get('tab')=='active':node['content']={'mod':'mnb-workload','props':{'mode':mode,'run':'relevo-'+mode}}
    for child in node.get('children',[]):walk(child,mode)
for mode in ['idle','inbox','edit-save','diff','sustained']:
    layout=json.loads((repo/'layouts/relevo.json').read_text());walk(layout,mode)
    (app/f'layouts/mnb-relevo-{mode}.json').write_text(json.dumps(layout,indent=2))
for name in ['relevo','relevo-agents','relevo-files','space-folders','issues']:
    for path in (app/'mods'/name).rglob('*'):
        if path.is_file():manifest['files'][str(path.relative_to(app))]=hashlib.sha256(path.read_bytes()).hexdigest()
(a.baseline.parent/'isolated-install-manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'installed':list(manifest['source_heads']),'scope':manifest['scope'],'profile':str(app),'conflicts_preserved':len(conflicts)}))
