import fs from 'node:fs';
import path from 'node:path';
import { run } from './process.mjs';
import { fingerprint, runChecks, attachArtifact, verifyArtifact, removeArtifact } from './evidence.mjs';
import { readState, transaction, taskById, event, uid, stateDir, privateDir } from './store.mjs';
import { proposePreference, updatePreference, deletePreference, preferencesFor, preferenceContext, proposeFromDecisions, decisionBatch, skillPrompt } from '../lib/workflow-preferences.js';
import { SKILLS } from '../config.js';

const terminalStates = new Set(['accepted', 'cancelled']);
const text = (value, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max;
const recipient = (actor) => actor && /^[-a-zA-Z0-9_/]+$/.test(actor.address ?? '');
const statusOf = (actor) => typeof actor.status === 'string' ? actor.status : actor.status?.state;
export function createRuntime({ home, runCommand = run, clock = Date.now, fingerprintImpl = fingerprint, checksImpl = runChecks } = {}) {
  const dir = privateDir(stateDir(home));
  const activeChecks = new Map();
  privateDir(path.join(dir, 'reports'));
  const update = (fn) => transaction(home, fn);
  const log = (doc, task, type, detail, actor) => event(doc, task, type, detail, actor, clock());
  const hc = (args) => runCommand(['hc', ...args], { timeout: 45000, limit: 65536 });
  const getActor = async (actor, root) => {
    const r = await hc(['get', '--json', actor.address]);
    if (r.code !== 0) throw Error(`Agent ${actor.address} is unavailable`);
    const found = JSON.parse(r.stdout);
    found.status = statusOf(found);
    if (found.state !== 'live' || !['idle', 'done', 'working'].includes(found.status)) throw Error(`Agent ${actor.address} is not ready (${found.status ?? found.state})`);
    const cwd = found.foreground?.cwd ?? found.cwd;
    if (!cwd || fs.realpathSync(cwd) !== root) throw Error(`Agent ${actor.address} is in a different checkout. Select or move it explicitly.`);
    return found;
  };
  const interruptAttempt = async (task, attempt) => {
    try {
      const actor = await getActor({ address: attempt.address }, task.root);
      if (['idle', 'done'].includes(actor.status)) return { code: 0 };
      if (!Number.isInteger(attempt.startedTurn) || !Number.isInteger(actor.turn) || actor.turn > attempt.startedTurn + 1) return { code: 1, stderr: 'Agent turn changed; inspect it before interrupting' };
      return await hc(['interrupt', attempt.address]);
    } catch (error) { return { code: 1, stderr: error.message }; }
  };
  function validateTask(input, doc, allowedNewDependencies = []) {
    if (!input || !text(input.goalId, 100) || !text(input.title, 240) || !text(input.criteria, 4000) || !path.isAbsolute(input.root ?? '')) throw Error('Choose a goal, title, repository and expected outcome');
    const goals = JSON.parse(fs.readFileSync(path.join(home, 'relevo-goals.json'), 'utf8'));
    if (!goals.goals?.some((g) => g.id === input.goalId && g.state !== 'completed')) throw Error('Choose an open goal');
    if (!recipient(input.executor) || !recipient(input.reviewer) || input.executor.address === input.reviewer.address) throw Error('Select different executor and reviewer agents');
    if ([input.executor, input.reviewer].some((actor) => actor.address.includes('/'))) throw Error('This workflow requires local agents in the selected checkout');
    if (!Array.isArray(input.checks ?? []) || (input.checks?.length ?? 0) > 10 || (input.checks ?? []).some((args) => !Array.isArray(args) || !args.length || args.length > 30 || args.some((a) => typeof a !== 'string' || a.length > 2000 || a.includes('\0')))) throw Error('Checks must be JSON arrays of command arguments');
    const dependencies = input.dependsOn ?? [];
    if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length || dependencies.some((id) =>
      !doc.tasks.some((t) => t.id === id && t.goalId === input.goalId) && !allowedNewDependencies.includes(id))) throw Error('Dependencies must be existing tasks in this goal');
    const maxRounds = input.maxRounds ?? 2, maxMinutes = input.maxMinutes ?? 20;
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5 || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) throw Error('Use 1–5 attempts and a 1–120 minute limit');
    return { id: uid(), goalId: input.goalId, title: input.title.trim(), criteria: input.criteria.trim(), root: fs.realpathSync(input.root),
      executor: { address: input.executor.address, label: input.executor.label || input.executor.address }, reviewer: { address: input.reviewer.address, label: input.reviewer.label || input.reviewer.address },
      checks: input.checks ?? [], dependsOn: dependencies, maxRounds, maxMinutes, round: 0, state: 'planned', paused: false,
      attempts: [], messages: [], evidence: [], decisions: [], checksResult: [], revision: '', createdAt: new Date(clock()).toISOString(), error: null };
  }
  function planScopeIssue(task, doc) {
    if (!task.planId) return null;
    const plan = (doc.plans ?? []).find((item) => item.id === task.planId);
    if (!plan || plan.state !== 'started') return 'The linked goal plan is no longer active; inspect it before continuing.';
    const goal = JSON.parse(fs.readFileSync(path.join(home, 'relevo-goals.json'), 'utf8')).goals?.find((item) => item.id === task.goalId);
    if (!goal) return 'The linked goal was removed; inspect this task before continuing.';
    if ((goal.state ?? 'active') !== 'active') return 'The linked goal is not active; reopen it before continuing this task.';
    const step = (goal.steps ?? []).find((item) => item.id === task.goalStep?.id);
    if (!step || step.title !== task.goalStep?.title || step.state === 'done' || goal.criteria !== task.goalStep?.criteria) {
      return 'The linked goal step or acceptance criteria changed after this plan started; review the plan before continuing.';
    }
    return null;
  }
  function dependencyWaitReason(task, doc) {
    const pending = task.dependsOn.map((id) => taskById(doc, id)).filter((dependency) => dependency.state !== 'accepted');
    if (!pending.length) return null;
    const attention = pending.filter((dependency) => ['cancelled', 'blocked', 'failed'].includes(dependency.state));
    if (attention.length) {
      const summaries = attention.slice(0, 3).map((dependency) => `“${dependency.title}” (${dependency.state})`);
      const more = attention.length > 3 ? ` and ${attention.length - 3} more` : '';
      return `Waiting on prerequisite ${summaries.join(', ')}${more}. Resolve or replace the prerequisite to continue.`.slice(0, 1000);
    }
    const titles = pending.slice(0, 3).map((dependency) => `“${dependency.title}”`);
    const more = pending.length > 3 ? ` and ${pending.length - 3} more` : '';
    return `Waiting for human acceptance of ${titles.join(', ')}${more}.`.slice(0, 1000);
  }
  async function command(payload) {
    if (!payload || typeof payload !== 'object') throw Error('Command required');
    const action = payload.action;
    if (action === 'read') return { doc: readState(home) };
    if (action === 'create') {
      const task = validateTask(payload.task, readState(home));
      await fingerprintImpl(task.root);
      await getActor(task.executor, task.root); await getActor(task.reviewer, task.root);
      return update((doc) => { validateTask(payload.task, doc); doc.tasks.push(task); log(doc, task, 'Task created', 'Existing agents linked; no message sent', 'Human'); return { taskId: task.id }; });
    }
    if (action === 'create-plan') {
      const planId = payload.planId;
      if (!text(planId, 100) || !text(payload.goalId, 100) || !Number.isSafeInteger(payload.goalVersion) || payload.goalVersion < 1 ||
          !Array.isArray(payload.stepIds) || payload.stepIds.length < 1 || payload.stepIds.length > 20 ||
          payload.stepIds.some((id) => !text(id, 100)) || new Set(payload.stepIds).size !== payload.stepIds.length) throw Error('Choose a plan ID, goal version and 1–20 unique goal steps');

      const existing = (doc) => (doc.plans ?? []).find((plan) => plan.id === planId);
      const sameRequest = (doc, plan) => {
        const tasks = plan.taskIds.map((id) => doc.tasks.find((task) => task.id === id));
        let root;
        try { root = fs.realpathSync(payload.root); } catch { return false; }
        return plan.goalId === payload.goalId && plan.goalVersion === payload.goalVersion &&
          plan.stepIds.length === payload.stepIds.length && plan.stepIds.every((id) => payload.stepIds.includes(id)) && tasks.length === payload.stepIds.length &&
          tasks.every((task, index) => task?.planId === planId && task.goalId === payload.goalId && task.goalStep?.id === plan.stepIds[index] &&
            task.root === root && task.executor?.address === payload.executor?.address && task.executor?.label === (payload.executor?.label || payload.executor?.address) &&
            task.reviewer?.address === payload.reviewer?.address && task.reviewer?.label === (payload.reviewer?.label || payload.reviewer?.address) &&
            JSON.stringify(task.checks) === JSON.stringify(payload.checks ?? []) && task.maxRounds === (payload.maxRounds ?? 2) &&
            task.maxMinutes === (payload.maxMinutes ?? 20));
      };
      const before = readState(home), prior = existing(before);
      if (prior) {
        if (!sameRequest(before, prior)) throw Error('Plan ID is already in use for a different plan');
        return { doc: before, result: { planId, taskIds: prior.taskIds, existing: true } };
      }

      const readGoal = () => {
        const goals = JSON.parse(fs.readFileSync(path.join(home, 'relevo-goals.json'), 'utf8'));
        const goal = goals.goals?.find((item) => item.id === payload.goalId);
        if (!goal || goal.version !== payload.goalVersion || (goal.state ?? 'active') !== 'active') throw Error('The goal changed or is not active. Reopen it before creating this plan.');
        if (!text(goal.criteria, 4000)) throw Error('The goal needs expected criteria before it can be planned');
        const steps = goal.steps ?? [];
        if (!Array.isArray(steps) || steps.length > 20) throw Error('The goal plan is invalid or exceeds 20 steps');
        const selected = new Set(payload.stepIds);
        const ordered = steps.filter((step) => selected.has(step.id));
        if (ordered.length !== selected.size || ordered.some((step) => step.state === 'done')) throw Error('Choose existing goal steps that are not already done');
        return { goal, steps: ordered };
      };
      const { goal, steps } = readGoal();
      if (before.tasks.length + steps.length > 200) throw Error('Workflow task limit reached; archive tasks before creating this plan');
      const requestedOrder = steps.map((step) => step.id);
      const ids = steps.map(() => uid());
      const planTasks = [];
      for (let index = 0; index < steps.length; index++) {
        const step = steps[index], id = ids[index];
        const taskInput = { goalId: payload.goalId, title: step.title,
          criteria: `${goal.criteria.trim()}\n\nStep expected outcome: ${step.title.trim()}`, root: payload.root,
          executor: payload.executor, reviewer: payload.reviewer, checks: payload.checks ?? [],
          dependsOn: index ? [ids[index - 1]] : [], maxRounds: payload.maxRounds, maxMinutes: payload.maxMinutes };
        const task = validateTask(taskInput, { ...before, tasks: [...before.tasks, ...planTasks] }, index ? [ids[index - 1]] : []);
        task.id = id; task.planId = planId;
        task.goalStep = { id: step.id, title: step.title, criteria: goal.criteria };
        planTasks.push(task);
      }
      await fingerprintImpl(planTasks[0].root);
      await getActor(planTasks[0].executor, planTasks[0].root); await getActor(planTasks[0].reviewer, planTasks[0].root);
      return update((doc) => {
        const raced = existing(doc);
        if (raced) {
          if (!sameRequest(doc, raced)) throw Error('Plan ID is already in use for a different plan');
          return { planId, taskIds: raced.taskIds, existing: true };
        }
        const current = readGoal();
        if (current.goal.version !== goal.version || JSON.stringify(current.goal) !== JSON.stringify(goal)) throw Error('The goal changed while this plan was being created');
        if (doc.tasks.length + planTasks.length > 200) throw Error('Workflow task limit reached; archive tasks before creating this plan');
        for (const step of steps) if (doc.tasks.some((task) => task.goalId === payload.goalId && task.goalStep?.id === step.id && task.state !== 'cancelled')) {
          throw Error(`Goal step already has a noncancelled task: ${step.title}`);
        }
        if ((doc.plans ?? []).length >= 200) throw Error('Workflow plan limit reached; archive plans before continuing');
        // Revalidate against the committed document and current goal before adding any task.
        let previous = null;
        for (const task of planTasks) {
          validateTask({ ...task, dependsOn: previous ? [previous] : [] }, { ...doc, tasks: [...doc.tasks, ...planTasks.filter((candidate) => candidate.id !== task.id)] }, previous ? [previous] : []);
          previous = task.id;
        }
        doc.plans ??= [];
        doc.tasks.push(...planTasks);
        doc.plans.push({ id: planId, goalId: payload.goalId, goalVersion: payload.goalVersion, taskIds: ids,
          stepIds: requestedOrder, state: 'planned', createdAt: new Date(clock()).toISOString() });
        for (const task of planTasks) log(doc, task, 'Plan task created', `Goal step: ${task.goalStep.title}`, 'Human');
        return { planId, taskIds: ids, existing: false };
      });
    }
    if (action === 'start-plan') {
      const planId = payload.planId;
      if (!text(planId, 100)) throw Error('Choose a plan ID');
      const doc = readState(home), plan = (doc.plans ?? []).find((item) => item.id === planId);
      if (!plan) throw Error('Plan is no longer available');
      if (plan.state === 'started') return { doc, result: { planId, taskIds: plan.taskIds, existing: true } };
      if (plan.state !== 'planned') throw Error('Only a planned workflow can be started');
      const goal = JSON.parse(fs.readFileSync(path.join(home, 'relevo-goals.json'), 'utf8')).goals?.find((item) => item.id === plan.goalId);
      if (!goal || goal.version !== plan.goalVersion || (goal.state ?? 'active') !== 'active') throw Error('The goal changed or is not active. Reopen it before starting this plan.');
      const selected = new Set(plan.stepIds), currentSteps = (goal.steps ?? []).filter((step) => selected.has(step.id));
      const snapshotTasks = plan.taskIds.map((id) => doc.tasks.find((task) => task.id === id));
      if (currentSteps.length !== selected.size || currentSteps.some((step, index) => step.id !== plan.stepIds[index] || step.state === 'done' ||
          step.id !== snapshotTasks[index]?.goalStep?.id || step.title !== snapshotTasks[index]?.goalStep?.title || goal.criteria !== snapshotTasks[index]?.goalStep?.criteria)) throw Error('The plan no longer matches the goal steps');
      if (snapshotTasks.some((task) => task?.paused) && payload.resumePaused !== true) throw Error('One or more planned tasks are paused. Set resumePaused to true to explicitly resume this draft plan.');
      return update((next) => {
        const current = (next.plans ?? []).find((item) => item.id === planId);
        if (!current) throw Error('Plan is no longer available');
        if (current.state === 'started') return { planId, taskIds: current.taskIds, existing: true };
        if (current.state !== 'planned') throw Error('Only a planned workflow can be started');
        const reread = JSON.parse(fs.readFileSync(path.join(home, 'relevo-goals.json'), 'utf8')).goals?.find((item) => item.id === current.goalId);
        if (!reread || reread.version !== current.goalVersion || JSON.stringify(reread) !== JSON.stringify(goal) || (reread.state ?? 'active') !== 'active') throw Error('The goal changed while this plan was starting');
        const tasks = current.taskIds.map((id) => taskById(next, id));
        if (tasks.some((task, index) => task.planId !== planId || task.state !== 'planned' || (task.paused && payload.resumePaused !== true) || task.goalStep?.id !== current.stepIds[index] ||
            task.goalStep?.title !== (reread.steps ?? []).find((step) => step.id === task.goalStep?.id)?.title || task.goalStep?.criteria !== reread.criteria)) throw Error('Plan tasks changed or are paused; inspect them before starting');
        for (const task of tasks) {
          task.state = 'ready';
          if (payload.resumePaused === true) task.paused = false;
          log(next, task, 'Task started', payload.resumePaused === true ? 'Paused draft explicitly resumed; ready work runs when dependencies and agents are available' : 'Ready work runs when dependencies and agents are available', 'Human');
        }
        current.state = 'started'; next.engine.enabled = true;
        return { planId, taskIds: current.taskIds, existing: false };
      });
    }
    if (action === 'cancel-plan') {
      if (!text(payload.planId, 100)) throw Error('Choose a plan ID');
      const before = readState(home), plan = (before.plans ?? []).find((item) => item.id === payload.planId);
      if (!plan) throw Error('Plan is no longer available');
      if (plan.state === 'cancelled') return { doc: before, result: { planId: plan.id, taskIds: plan.taskIds, existing: true } };
      if (plan.state !== 'planned') throw Error('An active plan cannot be cancelled as a draft; cancel or finish its tasks individually.');
      return update((doc) => {
        const current = (doc.plans ?? []).find((item) => item.id === payload.planId);
        if (!current) throw Error('Plan is no longer available');
        if (current.state === 'cancelled') return { planId: current.id, taskIds: current.taskIds, existing: true };
        if (current.state !== 'planned') throw Error('An active plan cannot be cancelled as a draft; cancel or finish its tasks individually.');
        const tasks = current.taskIds.map((id) => taskById(doc, id));
        if (tasks.some((task) => task.planId !== current.id || !['planned', 'cancelled'].includes(task.state))) throw Error('Plan tasks changed; inspect them before cancelling this draft.');
        for (const task of tasks) if (task.state === 'planned') {
          task.state = 'cancelled'; task.paused = true; log(doc, task, 'Task cancelled', 'Draft plan cancelled before start', 'Human');
        }
        current.state = 'cancelled';
        return { planId: current.id, taskIds: current.taskIds, existing: false };
      });
    }
    if (action === 'stop') { for (const controller of activeChecks.values()) controller.abort(); return update((doc) => {
      doc.engine.enabled = false;
      for (const task of doc.tasks.filter((t) => !terminalStates.has(t.state))) task.paused = true;
      log(doc, null, 'Coordinator stopped', 'No new dispatches. Running agents keep their sessions.', 'Human');
    }); }
    if (action === 'preference-propose' || action === 'preference-update' || action === 'preference-delete') return update((doc) => {
      if (action === 'preference-propose') doc.preferences = proposePreference(doc.preferences, { ...payload.preference, id: uid() });
      else if (action === 'preference-update') doc.preferences = updatePreference(doc.preferences, payload.id, payload.patch);
      else doc.preferences = deletePreference(doc.preferences, payload.id);
      log(doc, null, 'Preference changed', 'Only accepted preferences are included in future tasks', 'Human');
    });
    if (action === 'suggest-preferences') return { doc: readState(home), suggestions: proposeFromDecisions(readState(home).tasks, { root: payload.root }) };
    if (action === 'batch') {
      const before = readState(home), selected = decisionBatch(before.tasks, payload.ids, payload.outcome, payload.revisions);
      if (payload.preview !== false) return { doc: before, preview: selected };
      const fingerprints = Object.fromEntries(await Promise.all(selected.map(async (item) => { const task = taskById(before, item.taskId); return [task.id, await fingerprintImpl(task.root)]; })));
      return update((doc) => {
        decisionBatch(doc.tasks, payload.ids, payload.outcome, payload.revisions);
        for (const item of selected) { const task = taskById(doc, item.taskId); decide(doc, task, { ...payload, revision: payload.revisions[task.id] }, fingerprints[task.id]); }
      });
    }
    const before = taskById(readState(home), payload.taskId);
    if (action === 'refresh') {
      const revision = await fingerprintImpl(before.root);
      const evidenceStatus = await Promise.all(before.evidence.map(async (e) => ({ id: e.id, valid: await verifyArtifact(e) })));
      return update((doc) => {
        const task = taskById(doc, before.id);
        for (const e of task.evidence) e.valid = evidenceStatus.find((s) => s.id === e.id)?.valid ?? false;
        if (task.revision && task.revision !== revision && ['needs_you', 'accepted'].includes(task.state)) {
          task.state = 'blocked'; task.error = 'The checkout changed. Run a new review before accepting.';
          log(doc, task, 'Review became stale', task.error);
        }
      });
    }
    if (action === 'attach') {
      const current = await fingerprintImpl(before.root);
      if (!before.revision || current !== before.revision) throw Error('Refresh and review this checkout before attaching evidence');
      const artifact = await attachArtifact({ stateDir: dir, taskId: before.id, source: payload.source, kind: payload.kind, revision: current, label: payload.label });
      try { return update((doc) => { const task = taskById(doc, before.id); if (task.revision !== current) throw Error('Task changed'); task.evidence.push(artifact); log(doc, task, 'Evidence attached', artifact.label || artifact.kind, 'Human'); }); }
      catch (e) { await removeArtifact(dir, artifact); throw e; }
    }
    if (action === 'remove-artifact') {
      const artifact = before.evidence.find((e) => e.id === payload.artifactId);
      if (!artifact) throw Error('Artifact no longer exists');
      await removeArtifact(dir, artifact);
      return update((doc) => { const task = taskById(doc, before.id); task.evidence = task.evidence.filter((e) => e.id !== artifact.id); log(doc, task, 'Evidence removed', artifact.label || artifact.kind, 'Human'); });
    }
    if (action === 'decide') {
      const current = await fingerprintImpl(before.root);
      return update((doc) => decide(doc, taskById(doc, before.id), payload, current));
    }
    if (action === 'retry-review') {
      const current = await fingerprintImpl(before.root);
      return update((doc) => { const task = taskById(doc, before.id);
        if (task.state !== 'blocked' || task.attempts.at(-1)?.role !== 'reviewer' || task.attempts.at(-1)?.state !== 'reported' || task.revision !== current || task.checksResult.some((check) => check.code !== 0)) throw Error('A fresh implementation and checks are required before retrying review');
        if (task.attempts.filter((attempt) => attempt.role === 'reviewer').length >= task.maxRounds + 1) throw Error('Review retry budget exhausted');
        task.state = 'needs_review'; task.nextRole = 'reviewer'; task.paused = false; task.error = null; doc.engine.enabled = true;
        log(doc, task, 'Review retry requested', 'Same checked revision; independent reviewer will reassess it', 'Human'); });
    }
    if (action === 'message' || action === 'skill') {
      if (!text(payload.text ?? payload.skill, 4000)) throw Error('Enter a message or configured skill');
      if (terminalStates.has(before.state)) throw Error('Start a new task for further work');
      if (action === 'skill' && !Object.values(SKILLS).includes(payload.skill)) throw Error('Choose an available configured skill');
      const message = action === 'skill' ? skillPrompt({ skill: payload.skill, title: before.title, criteria: [before.criteria], root: before.root,
        preferences: preferencesFor(readState(home).preferences, { goalId: before.goalId, root: before.root }) }) : payload.text.trim();
      const mode = payload.mode ?? 'queue'; if (!['queue', 'now'].includes(mode)) throw Error('Choose Queue follow-up or Send now');
      const result = update((doc) => { const task = taskById(doc, before.id); const queued = { id: uid(), text: message, mode, status: 'queued', address: task.executor.address, at: new Date(clock()).toISOString() }; task.messages.push(queued); doc.engine.enabled = true; log(doc, task, 'Message queued', message, 'Human'); return queued.id; });
      // Queue is held by Relevo until an idle session. Send now never forces a blocked prompt.
      if (mode === 'now') await deliverMessage(before.id, result.result);
      return { doc: readState(home) };
    }
    if (action === 'cancel') {
      activeChecks.get(before.id)?.abort();
      const active = before.attempts.at(-1);
      let interruption;
      if (active?.delivery === 'acknowledged' && active.state === 'running') interruption = await interruptAttempt(before, active);
      return update((doc) => { const task = taskById(doc, before.id); task.state = 'cancelled'; task.paused = true;
        const attempt = task.attempts.at(-1);
        if (attempt?.state === 'running') attempt.delivery = 'uncertain';
        task.error = interruption?.code ? 'Task cancelled, but interrupt was not confirmed. Inspect the agent session.' : attempt?.state === 'running' ? 'Inspect and reconcile the stopped attempt to release its checkout.' : null;
        log(doc, task, 'Task cancelled', task.error || 'No further dispatches; an interrupt request is not proof the agent stopped', 'Human'); });
    }
    if (action === 'reconcile') {
      const active = before.attempts.at(-1);
      if (!active || !['uncertain', 'sending'].includes(active.delivery)) throw Error('No uncertain attempt to reconcile');
      if (payload.attemptId !== active.id || payload.confirmStopped !== true) throw Error('Inspect the agent, then explicitly confirm this attempt stopped');
      const observed = await getActor({ address: active.address }, before.root);
      if (!['idle', 'done'].includes(observed.status)) throw Error('The agent is still working');
      return update((doc) => { const task = taskById(doc, before.id), attempt = task.attempts.at(-1);
        if (attempt?.id !== active.id) throw Error('Attempt changed');
        attempt.state = 'abandoned'; attempt.delivery = 'reconciled'; task.paused = true;
        task.error = 'Attempt reconciled as stopped. Resume starts a fresh bounded attempt.';
        log(doc, task, 'Attempt reconciled by human', `Stopped attempt ${attempt.id}; no resend`, 'Human'); });
    }
    return update((doc) => {
      const task = taskById(doc, before.id);
      if (action === 'pause') { task.paused = true; log(doc, task, 'Task paused', 'New dispatches paused; current agent may finish', 'Human'); return; }
      if (!['start', 'resume'].includes(action)) throw Error('Unknown workflow action');
      if (task.planId && (doc.plans ?? []).some((plan) => plan.id === task.planId && plan.state === 'planned')) throw Error('Start this work through Start plan');
      if (terminalStates.has(task.state)) throw Error('Create a new task after acceptance or cancellation');
      if (task.attempts.at(-1)?.delivery === 'uncertain') throw Error('Delivery is uncertain. Inspect the agent and reconcile this attempt before resuming.');
      if (task.state === 'blocked' && task.attempts.at(-1)?.state === 'running') throw Error('This attempt may still be running. Await its report or cancel and inspect the session.');
      task.paused = false; task.error = null; doc.engine.enabled = true;
      if (['planned', 'blocked', 'failed'].includes(task.state)) {
        if (task.round >= task.maxRounds) throw Error('Attempt budget exhausted. Create a new bounded task.');
        task.state = 'ready'; task.nextRole = 'executor';
      }
      log(doc, task, action === 'start' ? 'Task started' : 'Task resumed', 'Ready work runs when dependencies and agents are available', 'Human');
    });
  }
  function decide(doc, task, payload, current) {
    if (task.state !== 'needs_you' || !task.revision || payload.revision !== task.revision || current !== task.revision) throw Error('This review is stale or no longer awaiting a decision. Refresh it.');
    if (!['accept', 'changes', 'defer'].includes(payload.outcome)) throw Error('Choose Accept result, Request changes or Defer');
    if (payload.outcome === 'accept') {
      const issue = planScopeIssue(task, doc);
      if (issue) throw Error(issue);
    }
    if (payload.outcome === 'changes' && !text(payload.text)) throw Error('Explain the requested changes');
    if (payload.outcome === 'changes' && task.round >= task.maxRounds) throw Error('Attempt budget exhausted. Create a new bounded task for further changes.');
    task.decisions.push({ id: uid(), outcome: payload.outcome, text: String(payload.text ?? '').slice(0, 4000), revision: task.revision, at: new Date(clock()).toISOString() });
    if (payload.outcome === 'accept') { task.state = 'accepted'; task.paused = false; }
    else if (payload.outcome === 'changes') { task.state = 'ready'; task.nextRole = 'executor'; task.feedback = payload.text; task.paused = false; doc.engine.enabled = true; }
    else task.paused = true;
    log(doc, task, 'Human decision', `${payload.outcome}: ${payload.text || '(no additional note)'}`, 'Human');
  }
  async function deliverMessage(taskId, messageId) {
    const task = taskById(readState(home), taskId), message = task.messages.find((m) => m.id === messageId);
    if (!message || message.status !== 'queued') return;
    if (terminalStates.has(task.state)) return;
    if (task.attempts.at(-1)?.role === 'reviewer' && task.attempts.at(-1)?.state === 'running') return;
    // A queued follow-up cannot change the checkout underneath independent review.
    if (message.mode === 'queue' && (task.state === 'running' || task.state === 'needs_review')) return;
    const actor = await getActor(task.executor, task.root);
    if (message.mode === 'queue' && !['idle', 'done'].includes(actor.status)) return;
    update((doc) => { const m = taskById(doc, taskId).messages.find((m) => m.id === messageId); if (m.status !== 'queued') throw Error('Message already submitted'); m.status = 'sending'; });
    let result;
    try { result = await hc(['send', '--json', ...(actor.status === 'done' ? [] : ['--if', actor.status]), message.address, message.text]); }
    catch (e) { result = { code: 1, stderr: e.message }; }
    update((doc) => { const t = taskById(doc, taskId), m = t.messages.find((m) => m.id === messageId); m.status = result.code === 0 ? 'delivered' : 'uncertain';
      if (['needs_you', 'needs_review'].includes(t.state)) { t.state = 'blocked'; t.error = 'A follow-up was sent. Refresh and run a new review before accepting.'; }
      log(doc, t, result.code === 0 ? 'Message delivered' : 'Message delivery uncertain', result.stderr || message.text, message.address); });
  }
  function prompt(task, attempt, preferences) {
    const file = path.join(dir, 'reports', `${attempt.id}.json`);
    const report = JSON.stringify({ attemptId: attempt.id, token: attempt.token, status: 'completed', summary: 'Describe the verified outcome' });
    return [`Relevo task ${task.id}; attempt ${attempt.id}; role ${attempt.role}.`, `Goal: ${task.title}`, `Expected outcome: ${task.criteria}`, `Repository: ${task.root}`,
      attempt.role === 'reviewer' ? 'Independently review the current changes and checks. Do not edit files. Report changes_requested with actionable findings if needed.' : 'Implement only this task. Read applicable repository instructions. Do not spawn agents, push, merge, release, or modify unrelated work.',
      task.feedback ? `Requested corrections: ${task.feedback}` : '',
      task.checks.length ? `Configured checks: ${JSON.stringify(task.checks)}` : 'No automated check command was configured; report that limitation.',
      attempt.role === 'reviewer' ? `Observed check results from the coordinator: ${JSON.stringify(task.checksResult.map((check) => ({ argv: check.argv, code: check.code, stdout: check.stdout?.slice(-2000), stderr: check.stderr?.slice(-2000) }))).slice(0, 16000)}\nAssess these observed outputs and independently inspect the code and tests. A read-only session need not rerun commands; explicitly state that limitation. Report blocked if the available evidence is insufficient for your review.` : '',
      preferenceContext(preferences),
      `Return a structured report by writing this JSON file locally: ${file}`, report,
      'Use status completed, changes_requested (reviewer only), or blocked. Replace summary with your actual findings. Do not claim human acceptance. Write the report after all changes/checks; it is the handoff to the coordinator.',
      `Limit: ${task.maxMinutes} minutes per attempt. Stop and report blocked if permissions or scope are unclear.`].filter(Boolean).join('\n\n');
  }
  async function dispatch(taskId) {
    const doc = readState(home), task = taskById(doc, taskId), role = task.nextRole || (task.state === 'needs_review' ? 'reviewer' : 'executor'), actor = task[role];
    if (!doc.engine.enabled || task.paused || !['ready', 'needs_review'].includes(task.state)) return;
    const scopeIssue = planScopeIssue(task, doc);
    if (scopeIssue) { block(task.id, scopeIssue); return; }
    const waitingReason = dependencyWaitReason(task, doc);
    if (waitingReason) {
      if (task.waitingReason !== waitingReason) update((next) => {
        const current = taskById(next, task.id), currentReason = dependencyWaitReason(current, next);
        if (current.state === 'ready' && !current.paused && currentReason && current.waitingReason !== currentReason) current.waitingReason = currentReason;
      });
      return;
    }
    if (task.waitingReason) {
      update((next) => {
        const current = taskById(next, task.id);
        if (current.state === 'ready' && !current.paused && !dependencyWaitReason(current, next)) current.waitingReason = null;
      });
    }
    const working = doc.tasks.filter((t) => ['running'].includes(t.state));
    if (working.length >= doc.engine.maxConcurrent || working.some((t) => t.root === task.root || [t.executor.address, t.reviewer.address].includes(actor.address))) return;
    let observed;
    try { observed = await getActor(actor, task.root); } catch (e) { block(task.id, e.message); return; }
    if (!['idle', 'done'].includes(observed.status)) return;
    const revision = await fingerprintImpl(task.root);
    if (role === 'reviewer' && task.revision !== revision) { block(task.id, 'Checkout changed after checks. Start a fresh attempt.'); return; }
    const attempt = { id: uid(), role, address: actor.address, token: uid(), delivery: 'sending', state: 'running', at: new Date(clock()).toISOString(), revision, startedTurn: observed.turn };
    attempt.prompt = prompt(task, attempt, preferencesFor(doc.preferences, { goalId: task.goalId, root: task.root }));
    update((next) => {
      const t = taskById(next, task.id);
      // Human controls can change while the agent and checkout are inspected.
      // Leave that decision intact; the attempt-id guard below prevents a send.
      if (!next.engine.enabled || t.paused || !['ready', 'needs_review'].includes(t.state)) return;
      const scopeIssue = planScopeIssue(t, next);
      if (scopeIssue) throw Error(scopeIssue);
      const currentWaitingReason = dependencyWaitReason(t, next);
      if (currentWaitingReason) {
        t.waitingReason = currentWaitingReason;
        return { waiting: true };
      }
      const active = next.tasks.filter((other) => other.id !== t.id && other.attempts.at(-1)?.state === 'running');
      if (active.length >= next.engine.maxConcurrent || active.some((other) => other.root === t.root || [other.executor.address, other.reviewer.address].includes(actor.address))) throw Error('Another attempt is using this checkout or agent');
      if (role === 'executor') { if (t.round >= t.maxRounds) throw Error('Attempt budget exhausted'); t.round++; }
      t.state = 'running'; t.waitingReason = null; t.attempts.push(attempt); t.error = null;
      log(next, t, 'Task assigned', `${role} → ${actor.label || actor.address}; attempt ${attempt.id}`);
    });
    if (taskById(readState(home), task.id).attempts.at(-1)?.id !== attempt.id) return;
    let result;
    // hc accepts an exact guard only for idle/working. A freshly observed done
    // session uses normal send, which still refuses blocked permission prompts.
    try { result = await hc(['send', '--json', ...(observed.status === 'done' ? [] : ['--if', 'idle']), actor.address, attempt.prompt]); }
    catch (e) { result = { code: 1, stderr: e.message }; }
    update((next) => {
      const t = taskById(next, task.id), a = t.attempts.find((a) => a.id === attempt.id);
      a.delivery = result.code === 0 ? 'acknowledged' : 'uncertain';
      if (result.code !== 0 && !terminalStates.has(t.state)) { t.state = 'blocked'; t.error = 'Delivery not confirmed. Inspect this attempt; no automatic resend.'; }
      log(next, t, result.code === 0 ? 'Delivery acknowledged' : 'Delivery uncertain', result.stderr || 'Transport accepted the message; completion is still pending', actor.address);
    });
  }
  function block(taskId, reason) {
    const current = taskById(readState(home), taskId);
    if (terminalStates.has(current.state) || (current.state === 'blocked' && current.error === reason)) return;
    update((doc) => { const task = taskById(doc, taskId); task.state = 'blocked'; task.error = reason; log(doc, task, 'Task blocked', reason); });
  }
  async function collect(task) {
    const attempt = task.attempts.at(-1);
    if (!attempt || attempt.state !== 'running' || !['running', 'blocked'].includes(task.state)) return;
    const file = path.join(dir, 'reports', `${attempt.id}.json`);
    if (fs.existsSync(file)) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) { block(task.id, 'Invalid agent report file'); return; }
      let report;
      try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
      if (report.attemptId !== attempt.id || report.token !== attempt.token || !['completed', 'changes_requested', 'blocked'].includes(report.status) || !text(report.summary, 10000)) { block(task.id, 'Invalid or mismatched agent report'); return; }
      const actor = await hc(['get', '--json', attempt.address]);
      if (actor.code !== 0) { block(task.id, 'Agent disconnected before its report could be verified'); return; }
      const state = JSON.parse(actor.stdout);
      state.status = statusOf(state);
      // Wait until the reporting agent has stopped writing the checkout.
      if (state.status === 'working') return;
      if (!['idle', 'done'].includes(state.status)) { block(task.id, `Agent stopped with ${state.status ?? state.state}`); return; }
      const revision = await fingerprintImpl(task.root);
      let checks = task.checksResult;
      if (attempt.role === 'executor' && report.status === 'completed') {
        const controller = new globalThis.AbortController(); activeChecks.set(task.id, controller);
        const checkCancellation = () => {
          try { const doc = readState(home); if (!doc.engine.enabled || taskById(doc, task.id).state === 'cancelled') controller.abort(); }
          catch { controller.abort(); }
        };
        const watcher = fs.watch(dir, (_event, name) => { if (String(name) === 'state.json') checkCancellation(); });
        checkCancellation();
        try { checks = await checksImpl(task.root, task.checks, { signal: controller.signal,
          timeoutMs: Math.max(1, Math.min(task.maxMinutes * 60000 - (clock() - Date.parse(attempt.at)), 60000)) }); }
        finally { watcher.close(); activeChecks.delete(task.id); }
        // Stop/cancel is not a failed check. Keep the report available so an
        // explicit resume validates this same attempt without another round.
        if (controller.signal.aborted) return;
      }
      const afterChecks = await fingerprintImpl(task.root);
      update((doc) => {
        const t = taskById(doc, task.id), a = t.attempts.at(-1);
        if (a?.id !== attempt.id || a.state !== 'running' || terminalStates.has(t.state)) return;
        a.state = 'reported'; a.report = { status: report.status, summary: report.summary }; a.summary = report.summary;
        // A valid attempt-specific report also reconciles an uncertain delivery.
        a.delivery = 'acknowledged'; t.error = null;
        log(doc, t, 'Agent reported', `${attempt.role}: ${report.summary}`, attempt.address);
        if (report.status === 'blocked') { t.state = 'blocked'; t.error = report.summary; return; }
        if (attempt.role === 'reviewer' && (revision !== attempt.revision || afterChecks !== revision)) { t.state = 'blocked'; t.error = 'Review is stale: checkout changed during review'; return; }
        if (attempt.role === 'executor' && afterChecks !== revision) { t.state = 'blocked'; t.error = 'Checks changed the checkout. Review the changes before retrying.'; return; }
        const failed = checks.some((check) => check.code !== 0);
        if ((attempt.role === 'reviewer' && report.status === 'changes_requested') || (attempt.role === 'executor' && (failed || report.status !== 'completed'))) {
          t.feedback = failed ? `Checks failed: ${JSON.stringify(checks)}` : report.summary;
          t.checksResult = checks; t.revision = afterChecks;
          if (t.round >= t.maxRounds) { t.state = 'blocked'; t.error = 'Correction budget exhausted; human direction required'; }
          else { t.state = 'ready'; t.nextRole = 'executor'; }
          return;
        }
        t.revision = afterChecks;
        if (attempt.role === 'executor') { t.checksResult = checks; t.state = 'needs_review'; t.nextRole = 'reviewer'; log(doc, t, 'Checks observed', checks.length ? `${checks.length} checks passed` : 'No checks configured'); }
        else { t.state = 'needs_you'; log(doc, t, 'Human review requested', 'Inspect changes and evidence, then accept, request changes or defer'); }
      });
      return;
    }
    if (!attempt.timedOut && clock() - Date.parse(attempt.at) > task.maxMinutes * 60000) {
      if (attempt.delivery === 'acknowledged') await interruptAttempt(task, attempt);
      update((doc) => { const t = taskById(doc, task.id), a = t.attempts.at(-1); if (a?.id !== attempt.id) return;
        a.timedOut = true; a.delivery = 'uncertain'; t.state = 'blocked'; t.error = 'Attempt time limit reached; inspect and reconcile the agent before continuing'; log(doc, t, 'Attempt timed out', t.error); });
    }
  }
  async function tick() {
    let doc = readState(home); if (!doc.engine.enabled) return;
    for (const task of doc.tasks) {
      if (terminalStates.has(task.state)) continue;
      try { await collect(task); } catch (e) { block(task.id, e.message); }
    }
    doc = readState(home);
    for (const task of doc.tasks) {
      if (task.paused || terminalStates.has(task.state)) continue;
      try {
        const queued = task.messages.find((m) => m.status === 'queued');
        if (queued && !['running', 'needs_review'].includes(task.state)) { await deliverMessage(task.id, queued.id); continue; }
        await dispatch(task.id);
      } catch (e) { block(task.id, e.message); }
    }
  }
  function recover() {
    return update((doc) => {
      for (const task of doc.tasks) {
        const a = task.attempts.at(-1);
        if (a?.delivery === 'sending') { a.delivery = 'uncertain'; task.state = 'blocked'; task.error = 'Coordinator restarted during delivery. Await report or inspect the agent; no resend.'; log(doc, task, 'Delivery requires reconciliation', task.error); }
        for (const m of task.messages) if (m.status === 'sending') m.status = 'uncertain';
      }
    });
  }
  return { command, tick, recover, dispatch, read: () => readState(home) };
}
