#!/usr/bin/env python3
"""Same native API workload with baseline and Relevo layouts; no user input or terminals."""
import argparse, datetime, json, os, pathlib, subprocess, time
from sample_processes import capture, utc

p=argparse.ArgumentParser(); p.add_argument('phase',choices=['baseline','relevo','fixed']);p.add_argument('--gui-pid',type=int,required=True);p.add_argument('--core-pid',type=int,required=True);a=p.parse_args()
out=pathlib.Path('evidence/20261102T1540Z-baseline')/a.phase;out.mkdir(exist_ok=True)
env=dict(os.environ,HERDR_APP_HOME='/tmp/hmnb-20261102/app')
app=os.environ.get('HERDR_APP_BINARY',str(pathlib.Path.home()/'Applications/Herdr.app/Contents/MacOS/Herdr'))
events=[]
def command(*args):
    start=time.monotonic();r=subprocess.run([app,*args],env=env,capture_output=True,text=True,timeout=20)
    event=dict(utc=utc(),args=list(args),wall_ms=(time.monotonic()-start)*1000,code=r.returncode,stdout=r.stdout,stderr=r.stderr)
    events.append(event);(out/'commands.json').write_text(json.dumps(events,indent=2))
    if r.returncode:raise RuntimeError(event)
    if args == ("status",) and json.loads(r.stdout).get("errors"):raise RuntimeError(event)
    return r.stdout

for mode,seconds in [('idle',60),('inbox',60),('edit-save',60),('diff',60),('sustained',180)]:
    # Native fixture is unchanged across phases; Inbox is absent in the shipped baseline.
    command('do','layout.switch','--name',f'mnb-{a.phase}-{mode}')
    print(json.dumps(dict(event='start',phase=a.phase,mode=mode,utc=utc(),seconds=seconds)),flush=True)
    start=time.monotonic()
    with (out/f'{mode}.jsonl').open('x') as f:
        for i in range(seconds):
            f.write(json.dumps(dict(utc=utc(),monotonic_s=time.monotonic(),sample=i,replicate=i//(seconds//3),phase=a.phase,scenario=mode,processes=list(capture([a.gui_pid,a.core_pid]))))+'\n');f.flush()
            time.sleep(max(0,start+i+1-time.monotonic()))
    for _ in range(3):command('status')
    command('shot',str((out/f'{mode}.png').resolve()))
    print(json.dumps(dict(event='complete',phase=a.phase,mode=mode,utc=utc(),samples=seconds)),flush=True)
command('do','layout.switch','--name',f'mnb-{a.phase}-idle')
print(json.dumps(dict(event='phase-complete',phase=a.phase,utc=utc())),flush=True)
