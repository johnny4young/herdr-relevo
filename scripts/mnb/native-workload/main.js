// Measurement-only fixture, identical before/after. No agents, credentials, network or key input.
import { View, div } from "gpui-kit";
import { Editor, EditorState, v_flex } from "gpui-base";
import { props, readTextFile, writeTextFile, appHome, theme } from "herdr";
export default class Workload extends View {
 init(_p,cx) {
  const p=props() ?? {mode:"idle",run:"check"}; this.mode=p.mode; this.records=[]; this.count=0; this.busy=false; this.open=true;
  this.path=`${appHome()}/data/fixture-${this.mode}.js`;
  this.log=`${appHome()}/data/${p.run}.json`; this.previous=null; this.ready=false;
  cx.spawn(async ()=>{this.previous=await readTextFile(this.path);this.ready=true;});
  this.original=Array.from({length:4000},(_,i)=>`export const item${i} = ${i};`).join("\n")+"\n";
  this.editor=EditorState.new({language:"js",readonly:this.mode!=="edit-save",value:this.original,font_size:12});
  if(this.mode!=="idle" && this.mode!=="inbox") cx.timer.every(1000,cx=>this.tick(cx));
 }
 tick(cx) {
  if(this.busy || !this.open || !this.ready)return; this.busy=true; const scheduled=Date.now();
  cx.spawn(async cx=>{
   const start=Date.now(); let error=null;
   try {
    if(this.mode==="edit-save" || (this.mode==="sustained" && this.count%2===0)) {
     const text=this.original+`// isolated edit ${this.count}\n`;
     this.editor.set_value(text); await writeTextFile(this.path,text,this.previous); this.previous=text;
     if(await readTextFile(this.path)!==text) throw new Error("save/readback mismatch");
    } else {
     this.editor.set_value(Array.from({length:4000},(_,i)=>`${i%2?"+":"-"} export const item${i} = ${i+this.count};`).join("\n"));
    }
   }catch(e){error=String(e);}
   this.records.push({at:Date.now(),dispatch_ms:start-scheduled,operation_ms:Date.now()-start,operation:this.mode,index:this.count,error});
   this.count++; this.busy=false;
   if(this.open)cx.notify();
   if(this.count%10===0)await writeTextFile(this.log,JSON.stringify(this.records),await readTextFile(this.log));
  });
 }
 close() { this.open=false; this.editor.release(); }
 render() {const t=theme();return v_flex().size_full().bg(t.background).text_color(t.foreground).child(div().p(8).child(`MNB isolated workload: ${this.mode} (${this.count})`)).when(this.mode!=="idle" && this.mode!=="inbox",e=>e.child(Editor.new(this.editor).flex_1().min_h(0)));}
}
