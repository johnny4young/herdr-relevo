// Native integration driver: runs the unchanged Inbox.answer/press implementations once.
import { View } from "gpui-kit";
import { props, appHome, readTextFile, writeTextFile } from "herdr";
import { Inbox } from "./inbox.js";
export default class Probe extends View {
 init(p,cx) {
  this.inbox=new Inbox();this.inbox.init(p,cx);this.started=Date.now();this.sent=false;
  cx.timer.every(500,cx=>{
   if(this.sent||Date.now()-this.started>45000)return;
   const item=this.inbox.local.find(i=>i.kind==="blocked"&&i.agent.address===props().terminal);
   const option=item?.prompt?.options.find(o=>o.label==="Beta");
   if(!item||!option)return;
   this.sent=true;this.inbox.answer(item.agent,option,cx);
   cx.spawn(async()=>{const path=`${appHome()}/data/native-inbox-driver.json`;await writeTextFile(path,JSON.stringify({at:Date.now(),terminal:item.agent.address,question:item.prompt.question,option:option.label,source:"unchanged Inbox.answer/press; programmatic invocation"}),await readTextFile(path));});
  });
 }
 close(cx){this.inbox.close(cx);}
 render(cx){return this.inbox.render(cx);}
}
