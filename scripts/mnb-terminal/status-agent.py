#!/usr/bin/env python3
"""Bounded PSP/PTY fixture, not a Claude/Codex model. Reads only its own terminal."""
import os,sys,tty,termios,select,time,json,pathlib,base64
out=pathlib.Path('/tmp/hmnb-20261102/app/data/native-inbox-agent-result.json')
def status(state,kind=None):
 fields=['state='+state,'app=claude','title='+base64.b64encode(b'Synthetic Inbox fixture').decode()]
 if kind:fields.append('kind='+kind)
 sys.stdout.write('\x1b]7501;'+':'.join(fields)+'\x1b\\');sys.stdout.flush()
previous=termios.tcgetattr(0);tty.setraw(0);cursor=1;received=b'';started=time.monotonic();success=False
try:
 status('working');time.sleep(.2)
 sys.stdout.write('\x1b[2J\x1b[HWhich synthetic fixture?\r\n\r\n\u276f 1. Alpha\r\n  2. Beta\r\n');sys.stdout.flush();status('blocked','question')
 while time.monotonic()-started<60:
  ready,_,_=select.select([0],[],[],1)
  if not ready:continue
  part=os.read(0,1024);received+=part
  if b'\x1b[B' in received:cursor=2
  if b'\r' in part or b'\n' in part:
   success=cursor==2;break
 status('working');sys.stdout.write('\r\nNATIVE_INBOX_'+('BETA_OK' if success else 'FAILED')+'\r\n');sys.stdout.flush()
 out.write_text(json.dumps({'synthetic_agent':True,'real_pty':os.isatty(0),'selection':cursor,'success':success,'received_hex':received.hex(),'elapsed_s':time.monotonic()-started},indent=2))
 status('done' if success else 'error');time.sleep(3)
finally:termios.tcsetattr(0,termios.TCSANOW,previous)
sys.exit(0 if success else 1)
