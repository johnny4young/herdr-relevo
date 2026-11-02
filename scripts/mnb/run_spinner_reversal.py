#!/usr/bin/env python3
import json, os, pathlib, subprocess, time
from sample_processes import capture, utc

root=pathlib.Path('evidence/20261102T1540Z-baseline');out=root/'reversal';out.mkdir(exist_ok=True)
apphome=pathlib.Path('/tmp/hmnb-20261102/app');app=os.environ.get('HERDR_APP_BINARY',str(pathlib.Path.home()/'Applications/Herdr.app/Contents/MacOS/Herdr'))
env=dict(os.environ,HERDR_APP_HOME=str(apphome));gui=int((root/'fixed-gui.pid').read_text())
for label,revision in [('original','b53664ac8ab62ad0f2ecbaf756048329c435e84a'),('fixed','654a80bbbacaf0e70e51a0bbcee2c346f3f221b2')]:
    for name in ['inbox.js','inbox-prs.js']:
        content=subprocess.check_output(['git','-C','herdr-relevo','show',f'{revision}:mods/relevo/{name}'])
        (apphome/'mods/relevo'/name).write_bytes(content)
    print(json.dumps(dict(event='start',variant=label,utc=utc(),seconds=70,discard_first_seconds=10)),flush=True)
    start=time.monotonic()
    with (out/f'{label}.jsonl').open('x') as f:
        for i in range(70):
            f.write(json.dumps(dict(utc=utc(),monotonic_s=time.monotonic(),sample=i,phase='reversal',variant=label,processes=list(capture([gui,48360]))))+'\n');f.flush()
            time.sleep(max(0,start+i+1-time.monotonic()))
    subprocess.run([app,'shot',str((out/f'{label}.png').resolve())],env=env,check=True)
    print(json.dumps(dict(event='complete',variant=label,utc=utc(),samples=70)),flush=True)
