#!/usr/bin/env python3
"""Read process metadata only: never arguments, environment, logs or history."""
import argparse, datetime, json, pathlib, subprocess, time

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def capture(roots=None):
    raw = subprocess.check_output(['ps','-axo','pid=,ppid=,pcpu=,rss=,time=,comm='], text=True)
    rows = []
    for line in raw.splitlines():
        parts = line.strip().split(None, 5)
        if len(parts) != 6:
            continue
        pid, ppid, cpu, rss, cputime, comm = parts
        rows.append(dict(pid=int(pid),ppid=int(ppid),ps_cpu_percent=float(cpu),rss_kib=int(rss),cpu_time=cputime,executable=comm))
    selected = set(roots) if roots else {r['pid'] for r in rows if any(s in r['executable'].lower() for s in ('herdr','relevo'))}
    changed=True
    while changed:
        extra={r['pid'] for r in rows if r['ppid'] in selected}-selected
        changed=bool(extra); selected |= extra
    for r in rows:
        name=r['executable'].lower()
        if r['pid'] not in selected:
            continue
        if any(x in name for x in ('claude','codex','opencode')):
            r['group']='agent'
        elif '/plugins/' in name:
            r['group']='plugin'
        elif 'herdr.app/' in name:
            r['group']='herdr_gui'
        elif 'herdr-core' in name:
            r['group']='herdr_core'
        elif name.endswith('/herdr'):
            r['group']='herdr_tui'
        elif 'relevo' in name:
            r['group']='relevo'
        else:
            r['group']='other_child'
        # Executable paths retained; process arguments and terminal text excluded.
        yield r

def main():
    p=argparse.ArgumentParser(); p.add_argument('--out',required=True); p.add_argument('--label',required=True); p.add_argument('--seconds',type=int,default=30); p.add_argument('--interval',type=float,default=1); a=p.parse_args()
    target=pathlib.Path(a.out); target.parent.mkdir(parents=True,exist_ok=True)
    with target.open('x') as f:
        start=time.monotonic()
        for i in range(int(a.seconds/a.interval)):
            stamp=utc(); rows=list(capture())
            f.write(json.dumps(dict(utc=stamp,monotonic_s=time.monotonic(),label=a.label,sample=i,processes=rows))+'\n'); f.flush()
            time.sleep(max(0,start+(i+1)*a.interval-time.monotonic()))
    print(json.dumps(dict(file=str(target),label=a.label,samples=i+1,ended_utc=utc())))

if __name__=='__main__': main()
