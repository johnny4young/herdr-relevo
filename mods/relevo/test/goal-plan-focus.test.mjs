import './fake/register.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, resetFake } from './fake/herdr.mjs';
import { fakeCx, flush, find, click } from './fake/ui.mjs';
const { GoalEditor } = await import('../goals-editor.js');
const { InputState } = await import('gpui-base');
beforeEach(resetFake);
async function editor(count = 0) {
  const view = new GoalEditor(), cx = fakeCx(); view.init({}, cx); await flush();
  view.panel = 'plan'; view.fields.title.set_value('Retained title'); view.fields.criteria.set_value('Retained criteria');
  view.steps = Array.from({length: count}, (_,i) => ({id:`s${i}`,state:'todo',input:InputState.new({value:`Outcome ${i}`})}));
  cx.timers.length = 0; return { view, cx };
}
const add = (view, cx) => click(find(view.render(), 'goal-add-step'), cx);
const remove = (view, step, cx) => click(find(view.render(), `goal-step-remove-${step.id}`), cx);
function fire(cx) { for (const timer of cx.timers) timer.fn(cx); }

test('adding a plan step focuses its empty input after render and does not persist', async () => {
  const {view,cx}=await editor(1); add(view,cx); const step=view.steps[1]; let focused=0; step.input.focus=()=>{focused++;};
  assert.equal(focused,0); fire(cx); assert.equal(focused,1); assert.equal(step.state,'todo'); assert.equal(step.input.value(),'');
  assert.equal(view.steps[0].input.value(),'Outcome 0'); assert.deepEqual(fake.files,{}); assert.deepEqual(fake.execs,[]); view.close();
});

test('removing a middle or last step focuses the nearest retained input', async () => {
  for (const index of [1,2]) {
    const {view,cx}=await editor(3), removed=view.steps[index], target=view.steps[index===1?2:1]; let focused=0,released=0;
    target.input.focus=()=>{focused++;}; removed.input.release=()=>{released++;}; remove(view,removed,cx); fire(cx);
    assert.equal(focused,1); assert.equal(released,1); assert.equal(view.steps.length,2); assert.ok(view.steps.includes(target)); view.close();
  }
});

test('removing the only step returns focus to acceptance criteria and keeps the draft', async () => {
  const {view,cx}=await editor(1); let focused=0; view.fields.criteria.focus=()=>{focused++;}; remove(view,view.steps[0],cx); fire(cx);
  assert.equal(focused,1); assert.equal(view.steps.length,0); assert.equal(view.fields.criteria.value(),'Retained criteria'); assert.equal(view.fields.title.value(),'Retained title'); view.close();
});

test('repeated edits focus only the latest retained input and release a removed input once', async () => {
  const {view,cx}=await editor(); add(view,cx); const a=view.steps[0]; add(view,cx); const b=view.steps[1]; let af=0,bf=0,released=0;
  a.input.focus=()=>{af++;}; b.input.focus=()=>{bf++;}; b.input.release=()=>{released++;};
  const staleRemove=find(view.render(),`goal-step-remove-${b.id}`); click(staleRemove,cx); click(staleRemove,cx); fire(cx);
  assert.equal(af,1); assert.equal(bf,0); assert.equal(released,1); assert.deepEqual(view.steps,[a]); view.close();
});

test('pending plan focus is cancelled by leaving and returning to Plan, dismissal or saving', async () => {
  for (const action of ['navigate','close','save']) {
    const {view,cx}=await editor(); add(view,cx); let focused=0; const step=view.steps[0]; step.input.focus=()=>{focused++;};
    if(action==='navigate'){click(find(view.render(),'goal-panel-decision'),cx);click(find(view.render(),'goal-panel-plan'),cx);}
    else if(action==='close')view.close();
    else {view.fields.title.set_value('');view.save(cx);}
    fire(cx); assert.equal(focused,0,action); if(action!=='close')view.close();
  }
});

test('stale Add and Remove callbacks cannot mutate a closed, busy, unloaded or different-section editor', async () => {
  for (const state of ['closed','busy','unloaded','section']) {
    const {view,cx}=await editor(1),step=view.steps[0],addButton=find(view.render(),'goal-add-step'),removeButton=find(view.render(),`goal-step-remove-${step.id}`);
    let releases=0;step.input.release=()=>{releases++;};
    if(state==='closed')view.close();else if(state==='busy')view.busy=true;else if(state==='unloaded')view.goal=null;else view.panel='decision';
    const before=releases;click(addButton,cx);click(removeButton,cx);assert.deepEqual(view.steps,[step],state);assert.equal(releases,before,state);assert.equal(cx.timers.length,0,state);
    if(state!=='closed')view.close();
  }
});

test('a retained Add callback cannot exceed the twenty-step limit', async () => {
  const {view,cx}=await editor(19),addButton=find(view.render(),'goal-add-step');click(addButton,cx);click(addButton,cx);
  assert.equal(view.steps.length,20);assert.equal(find(view.render(),'goal-add-step').isDisabled,true);view.close();
});

test('ordinary add, remove and save retains unrelated fields through the versioned store', async () => {
  const {view,cx}=await editor(1);view.fields.owner.set_value('Draft owner');add(view,cx);view.steps[1].input.set_value('New result');remove(view,view.steps[0],cx);view.save(cx);await flush();
  const saved=JSON.parse(Object.values(fake.files)[0]).goals[0];assert.equal(saved.steps.length,1);assert.equal(saved.steps[0].title,'New result');assert.equal(saved.criteria,'Retained criteria');assert.equal(saved.owner,'Draft owner');view.close();
});
