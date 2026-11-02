#!/usr/bin/env python3
import json, pathlib, statistics

root=pathlib.Path('evidence/20261102T1540Z-baseline')
def cpu_time(value):
    parts=value.replace('-',':').split(':')
    return sum(float(v)*60**i for i,v in enumerate(reversed(parts)))
def interval_cpu(rows,group):
    values=[]
    for a,b in zip(rows,rows[1:]):
        before={p['pid']:p for p in a['processes'] if p['group']==group}
        used=sum(max(0,cpu_time(p['cpu_time'])-cpu_time(before[p['pid']]['cpu_time'])) for p in b['processes'] if p['group']==group and p['pid'] in before)
        values.append(100*used/(b['monotonic_s']-a['monotonic_s']))
    return statistics.mean(values) if values else None
result={}
for phase in ['baseline','relevo','fixed']:
    directory=root/phase
    if not directory.exists():continue
    result[phase]={}
    for mode,expected in [('idle',60),('inbox',60),('edit-save',60),('diff',60),('sustained',180)]:
        f=directory/f'{mode}.jsonl'
        if not f.exists():continue
        rows=[json.loads(l) for l in f.read_text().splitlines()]
        if len(rows)!=expected:continue
        entry={'samples':len(rows),'start_utc':rows[0]['utc'],'end_utc':rows[-1]['utc'],'groups':{}}
        for group in ['herdr_gui','herdr_core','plugin','agent','other_child']:
            rss=[sum(p['rss_kib'] for p in r['processes'] if p['group']==group)/1024 for r in rows]
            reps=[[r for r in rows if r['replicate']==i] for i in range(3)]
            entry['groups'][group]={'rss_mib_median':statistics.median(rss),'rss_mib_peak':max(rss),'rss_mib_first':rss[0],'rss_mib_last':rss[-1],'cpu_percent_mean':interval_cpu(rows,group),'replicates':[{'rss_mib_median':statistics.median([sum(p['rss_kib'] for p in r['processes'] if p['group']==group)/1024 for r in rep]),'cpu_percent_mean':interval_cpu(rep,group)} for rep in reps]}
        operation_file=directory/f'operations-{mode}.json'
        if operation_file.exists():
            records=json.loads(operation_file.read_text())
            if records:
                values=sorted(r['operation_ms'] for r in records)
                entry['operations']={'count':len(records),'errors':sum(r['error'] is not None for r in records),'median_ms':statistics.median(values),'p95_ms':values[min(len(values)-1,int(len(values)*.95))],'max_ms':max(values)}
        result[phase][mode]=entry
    commands=directory/'commands.json'
    if commands.exists():
        status=[x['wall_ms'] for x in json.loads(commands.read_text()) if x['args']==['status']]
        if status:result[phase]['status_latency']={'count':len(status),'median_ms':statistics.median(status),'max_ms':max(status)}
reversal={}
for variant in ['original','fixed']:
    file=root/'reversal'/f'{variant}.jsonl'
    if file.exists():
        rows=[json.loads(l) for l in file.read_text().splitlines()]
        if len(rows)==70:
            rows=rows[10:]
            rss=[sum(p['rss_kib'] for p in r['processes'] if p['group']=='herdr_gui')/1024 for r in rows]
            reversal[variant]={'samples':60,'discarded_initial_samples':10,'cpu_percent_mean':interval_cpu(rows,'herdr_gui'),'rss_mib_median':statistics.median(rss),'start_utc':rows[0]['utc'],'end_utc':rows[-1]['utc']}
if reversal:result['reversal']=reversal
(root/'native-summary.json').write_text(json.dumps(result,indent=2))
for phase,scenarios in result.items():
    for mode,entry in scenarios.items():
        if 'groups' not in entry:continue
        g=entry['groups']['herdr_gui'];print(phase,mode,'RSS median/peak MiB',round(g['rss_mib_median'],2),round(g['rss_mib_peak'],2),'CPU mean %',round(g['cpu_percent_mean'],2),entry.get('operations',''))
