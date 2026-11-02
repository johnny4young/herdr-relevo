// Programmatic native-host integration of an unchanged FileEditor source copy.
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { home, appHome, readTextFile, writeTextFile, theme } from "herdr";
import { FileEditor } from "./editor.js";
export default class Probe extends View {
 init(_p,cx) {
  this.records=[]; this.busy=true; this.n=0; this.path=`${home()}/code/perf-fixture/native-probe.js`;
  this.log=`${appHome()}/data/native-fileeditor-probe.json`;
  cx.spawn(async cx=>{
   try {
    const previous=await readTextFile(this.path);
    await writeTextFile(this.path,"export const test = 0;\n",previous);
    this.editor=new FileEditor(this.path); await this.editor.load(cx); this.editor.edit(cx); this.busy=false;cx.notify();
   }catch(e){this.error=String(e);cx.notify();}
  });
  cx.timer.every(2000,cx=>{
   if(this.busy || this.n>=10 || !this.editor?.state)return;this.busy=true;
   cx.spawn(async cx=>{
    const start=Date.now(),text=`export const test = ${++this.n};\n`;let error=null;
    try {this.editor.state.set_value(text);await this.editor.save(cx);if(await readTextFile(this.path)!==text)throw new Error("readback mismatch");}
    catch(e){error=String(e);}
    this.records.push({utc_ms:Date.now(),operation_ms:Date.now()-start,error,index:this.n,dirty:this.editor.dirty,note:this.editor.note});
    await writeTextFile(this.log,JSON.stringify(this.records),await readTextFile(this.log));this.busy=false;cx.notify();
   });
  });
 }
 close(){this.editor?.close();}
 render(){const t=theme();return v_flex().size_full().child(div().p(8).child(`Native FileEditor integration ${this.n}/10 ${this.error??""}`)).when(Boolean(this.editor),e=>e.child(this.editor.controls(t)).child(this.editor.body(t)));}
}
