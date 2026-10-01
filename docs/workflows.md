# Scripted workflows

A workflow is a small JavaScript program that spawns and coordinates many subagents: fan out over a list, push every item through the same stages, verify each result, return a summary. It runs in the background and reports as it goes.

The thing worth understanding up front is that **you do not write these — the model does.** You describe the work; it emits the script; you keep the file and re-run it. This guide is about that loop.

For the tool's parameter table and where it sits among the other tools, see [`README.md`](../README.md#subagentworkflow).

## What a workflow is

Until workflows existed, the only way to run several agents at once was to name them one by one in a single message. That is fine for three agents you already know about. It does not work for *"audit every route file in this repo"*, where the list only exists once something has gone and looked.

A script can loop, branch, and fan out over a list discovered at runtime. A batch of tool calls cannot. Each `agent()` call in the script spawns a real subagent with its own context window, its own tools, and its own model — the script is only the coordinator, and it has no filesystem or network of its own.

Use the `Agent` tool for one delegated task, or a handful you can name up front. Reach for a workflow when the *number* of agents depends on something discovered at runtime, when work flows through stages, or when you want findings independently verified before you believe them. It costs a subprocess per agent, so it is not the thing to dress a single task up as.

## The lifecycle

### 1. Ask for one

There is no `/workflows` command. The tool is model-invoked, so you get a workflow by asking for one in the prompt — the same way you ask for anything else. What you say shapes what you get:

| What you say | What you get |
|---|---|
| "audit every route file for missing auth checks" | A discovery agent, then a fan-out over what it found |
| "review the changed files for bugs, and verify each finding before reporting it" | Two stages, the second trying to refute the first |
| "fix the failing test, and don't tell me it's done until `npm test` passes" | A `gate` on the fix agent, and a retry loop around it |
| "use a workflow to …" | Forces the shape when the model would otherwise reach for plain `Agent` calls |

You do not have to say "workflow" — the model picks the tool — but saying it removes the ambiguity when the task is borderline.

### 2. Read what came back

The tool returns immediately. The run continues in the background and notifies you when it is done.

```text
Workflow "auth-audit" started in the background.
Task ID: wf_9f3ab21c04de
Script: /var/folders/xy/…/pi-subagents-501/Users-me-project/<session>/tasks/wf_9f3ab21c04de.workflow.js

You will be notified when it finishes — do NOT poll or sleep waiting for it.
To iterate, edit the script file and call SubagentWorkflow again with scriptPath.
```

Three things in there matter.

**`Task ID`** is what `resumeFromRunId` takes, and what `/agents → Workflows` lists the run under.

**`Script`** is the file to edit. **It is a scratch file in your system temp directory, not in your project** — it will not survive a reboot or a temp sweep. If the workflow turns out to be worth keeping, copy it somewhere durable; see [Save it](#5-save-it). The path means something slightly different depending on how the run was started: for an inline script it is a copy the tool just wrote, and for a run started from `scriptPath` or `name` it is *your own file*, reported straight back.

**The last line is addressed to the model, not to you.** You do not call `SubagentWorkflow` yourself — you tell the model to re-run the workflow at that path.

### 3. Watch it run

Three surfaces, in increasing order of detail.

A **card in the transcript**, updating as the run goes:

```text
▸ SubagentWorkflow  auth-audit                       3/7 agents · 1m12s
  Find routes missing auth checks, then verify each finding
  ╭─ Scan
  │ └─ ✔ discover        · Explore · haiku 4.5 · 26.4k · 8 tool calls · 25s
  ╰─ Audit
    ├─ ✔ audit:src/a.ts  · Explore · haiku 4.5 · 18.4k · 12 tool calls · 42s
    ├─ ⟳ audit:src/b.ts  · Explore · haiku 4.5 · 8 tool calls · 21s
    └─ ⟳ audit:src/c.ts
  ⎿  auditing 6 route files
```

A **`workflow` row in FleetView**, above the agents, carrying its agent counts where a description would go. `⏎` on it opens the inspector rather than a conversation overlay.

Each row names the model the child *actually* ran on — read back from its session once pi has resolved its defaults, not the string the script asked for — so a fuzzy `model: "haiku"` reads as the model it resolved to, and an `agent()` that named no model still says what it inherited.

The **inspector**, at `/agents → Workflows` — two panes, two levels: phases on the left, that phase's agents on the right, and `⏎` to descend into one agent's prompt, activity and outcome. The detail pane has room for the canonical `provider/model-id` and the thinking level, including differences from inherited/default levels. Unsupported caller effort or selected profile thinking defaults fail before session creation rather than being clamped. The full key table is in [the README](../README.md#commands); the four that change the run rather than the view are:

| Key | |
|---|---|
| `x` | Stop the run |
| `p` | Pause — running agents finish, no new ones start, and held time comes off the clock |
| `s` | **Skip** the selected agent: its `agent()` call returns `null` in the script |
| `r` | **Retry** the selected agent: the child is stopped and the same call runs again |

`s` and `r` are not view filters. Skipping an agent puts a `null` into the data your script is assembling, exactly as a terminal failure would; the script carries on with a hole in its results.

The fifth key only shows you something:

| Key | |
|---|---|
| `c` | Open the selected agent's **conversation** — the same viewer a fleet-list row opens, over the dialog |

Because it changes nothing, `c` works at both levels and on an agent that has already settled — which is the usual case, since reading what a child did is most of why the inspector gets opened. The dialog hides itself while the conversation is up and comes back when you close it. A row with no child behind it yet (queued, or replayed from the resume journal) has no conversation to open and does not offer the key.

A run's own agents are not listed separately in the fleet list, the widget, the `/agents` menus or `@handle` resolution — they belong to the run, which reports for them. `c` in the inspector is the one way in to a child's conversation.

### 4. Edit and re-run

Open the path from the `Script:` line, change it, and ask the model to run it again with `scriptPath`. That is the whole loop, and it is why the script is written to disk at all: iterating means editing a file, not asking the model to re-emit source it already produced.

Re-running normally re-pays for every agent. `resumeFromRunId` avoids that:

> Its unchanged leading `agent()` calls return their recorded results instantly; the first changed or failed call, and everything after it, runs live.

Every run journals each settled `agent()` call beside its script as `<run id>.workflow.jsonl`, and the resume replays the **unchanged prefix** of that journal. It is a prefix and not a lookup table on purpose: a later call that still matches came from a run whose earlier stages no longer exist, so its recorded answer was produced downstream of work that has changed.

Four things it will not do:

- **Cross sessions.** The journal is keyed to the session that wrote it. Restart pi and the run id is dead — you get `No workflow run "<id>" in this session.`
- **Resume a live run.** Stop it from `/agents → Workflows` first; while it is running you get `Workflow "<id>" is still running.`
- **Replay a failure.** A journaled failure ends the prefix, so resuming a run that died at agent 5 retries exactly agent 5. That is the point.
- **Replay a run that used `agent({ resume })` at all.** A replayed agent is text from a file rather than a live child, so there would be no conversation left for a later `resume` to continue.

Replayed rows are annotated `from resume journal` on the card and in the inspector, and the completion notification counts them — a resume never quietly looks like a run that was simply fast. Passing only `resumeFromRunId`, with no script of its own, re-runs that run's own script.

### 5. Save it

A script you will run more than once belongs somewhere durable. Copy it out of the temp directory into one of these, named `<name>.js`:

| Location | Scope |
|---|---|
| `<project>/.pi/workflows/<name>.js` | This project. Checked in, if you want it shared |
| `<project>/.agents/workflows/<name>.js` | This project, in the tool-agnostic directory |
| `<agent dir>/workflows/<name>.js` | You, everywhere — follows you across projects |

First hit wins, in that order, so a project file shadows a same-named global one.

The file must carry an `export const meta = { name, description }` declaration. Those are ordinary directories that may hold anything, so that declaration is what marks a file as a workflow — name something else and you are told it is not a workflow rather than getting a parse error from halfway through it. Nothing in the file is executed to decide that.

Then invoke it by name: *"run the auth-audit workflow"*. The model passes `name: "auth-audit"` and the run reports that file back as its `Script:`, so the edit-and-re-run loop still works on it.

**Nothing lists your saved workflows for you.** `/agents → Workflows` is a *run* inspector scoped to the current session, not a workflow browser — with five workflows saved on disk it will show you nothing. You reach a saved workflow by naming it to the model, or with [`--subagents-workflow-file=`](../README.md#cli-flags). Keeping the names memorable is on you.

### 6. Parameterize it

A workflow that hardcodes `src/routes/` is a one-off. Take the target from `args` instead, and it becomes reusable:

```js
export const meta = { name: 'audit', description: 'Audit a directory for missing auth checks' }

const root = args?.root ?? 'src/'
const listing = await agent(`List every file under ${root}. One path per line, nothing else.`)
```

`args` is whatever was passed to the tool, verbatim, and it must be JSON-shaped. Now *"run the audit workflow against src/api"* and *"…against src/admin"* are the same workflow.

## A worked example

The task: *"find routes that don't check auth, and don't just take the first answer — check each finding."*

The model writes something like this, and the run starts:

```js
export const meta = {
  name: 'auth-audit',
  description: 'Find routes missing auth checks, then verify each finding',
  phases: [{ title: 'Scan' }, { title: 'Audit' }, { title: 'Verify' }],
}

phase('Scan')
const listing = await agent('List every route file under src/routes/. One path per line, nothing else.')
const files = listing.split('\n').map(s => s.trim()).filter(Boolean)
log(`auditing ${files.length} route files`)

phase('Audit')
const findings = await pipeline(
  files,
  file => agent(`Audit ${file} for missing auth checks. Report findings or "none".`, { label: `audit:${file}` }),
  (found, file) => agent(`Try to REFUTE this finding about ${file}: ${found}`, { label: `verify:${file}`, phase: 'Verify' }),
)

return findings.filter(Boolean)
```

It works, but the result is a wall of prose you cannot sort — every verify agent answered in its own shape. So: edit the file, give the verify stage a `schema`, and return objects.

```js
const VERDICT = {
  type: 'object',
  properties: { file: { type: 'string' }, holds: { type: 'boolean' }, why: { type: 'string' } },
  required: ['file', 'holds'],
}

const findings = await pipeline(
  files,
  file => agent(`Audit ${file} for missing auth checks. Report findings or "none".`, { label: `audit:${file}` }),
  (found, file) => agent(`Try to REFUTE this finding about ${file}: ${found}`, { label: `verify:${file}`, phase: 'Verify', schema: VERDICT }),
)

return findings.filter(Boolean).filter(f => f.holds)
```

Only the second stage changed, so re-running with `resumeFromRunId` replays the whole `Scan` phase and every `audit:` call from the journal, and pays only for the verify agents. The notification says so: `… , 7 replayed from wf_9f3ab21c04de`.

Then it earns its keep — copy it to `.pi/workflows/auth-audit.js`, swap `src/routes/` for `args?.root ?? 'src/routes/'`, and from then on it is *"run auth-audit against src/api"*.

The finished script ships as [`examples/workflows/fan-out-audit.js`](../examples/workflows/fan-out-audit.js).

## Writing the script yourself

Occasionally you will want to write or heavily edit one. The rules are short.

**`meta` must be a pure literal** — no variables, function calls, spreads, or template interpolation. It is read *before* the script runs, which is what lets the phases appear on screen from the first frame instead of materializing one at a time as agents happen to start. `name` and `description` are required; `phases` and `whenToUse` are optional.

```js
export const meta = {
  name: 'my-workflow',
  description: 'One line, shown on the card and in the permission prompt',
  phases: [{ title: 'Scan', detail: 'grep for candidates' }, { title: 'Fix' }],
}
```

**The body is an async function body.** Top-level `await` and a bare top-level `return` are both allowed — the runtime wraps it. (This is also why a workflow script is not valid standalone JavaScript, and why your editor may complain about the `return`.)

**What you `return` crosses a JSON boundary.** It is checked for cycles, non-finite numbers, sparse arrays, symbol keys and exotic prototypes. Return something useful on its own — the caller sees your return value, not the individual agent outputs.

## Reference

### Tool parameters

| Parameter | Type | Description |
|---|---|---|
| `script` | string | Inline source. Must begin with `export const meta = { name, description }` |
| `scriptPath` | string | A script file, absolute or project-relative. **Takes precedence over `script`** — this is how an edited workflow is re-run |
| `name` | string | A saved workflow — `<name>.js` in one of the three directories above. Lowest precedence |
| `args` | any | Handed to the script as the `args` global, verbatim. Must be JSON-shaped |
| `resumeFromRunId` | string | Replay an earlier ordinary run in this session. Matches `^wf_[a-z0-9-]{6,}$`; refused for mutable TaskPlan runs |
| `taskPlan` | TaskPlan v1 | Predeclared Builder and Reviewer contracts; enables only the sequential task facade below |
| `recoveryCheckpointId` | string | Latest known-safe selected-branch task observation; requires the same TaskPlan and current Manager workers |
| `title` / `description` | string | Accepted and ignored — for Claude Code parity, so a ported call does not fail. A workflow is named by its `meta` block |

At least one of `script` / `scriptPath` / `name` is required; `scriptPath` wins over `script`, which wins over `name`.

### `agent(prompt, opts?)`

Spawns one subagent and resolves to its final text — or, with `schema`, to a validated object.

**Returns `null` if the agent failed terminally *or* if you skipped it from the inspector**, indistinguishably. Filter with `.filter(Boolean)` when a `null` would break a later stage, and be careful with in-script retry loops: retrying on `null` will re-run something you deliberately skipped.

| Option | Type | Notes |
|---|---|---|
| `label` | string | Display name in the progress tree. Also the handle `resume` addresses |
| `phase` | string | Put this agent in a named group, overriding the ambient `phase()`. **Use it inside `pipeline`/`parallel` stages**, where the ambient phase races |
| `agentType` | string | Which agent definition to use. Defaults to `general-purpose`; built-ins are `general-purpose`, `Explore`, `Plan`, plus your custom agents |
| `model` | string | Overrides the profile default; `provider/modelId`, or fuzzy like `haiku`. Unresolvable requests fail |
| `effort` | string | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Explicit values override profile `thinking`; unsupported caller choices or selected profile defaults fail before session creation. Omitted, profile then parent/settings defaults apply |
| `isolation` | `"worktree"` | Run in a throwaway git worktree. Only when agents write files in parallel and would collide — it costs setup time and disk per agent |
| `gate` | string | A shell command run after the agent finishes; a non-zero exit fails the agent and its output becomes the error |
| `resume` | string | Continue the child that ran under that label instead of starting fresh |
| `schema` | object | A JSON Schema with an object root. Resolves to the validated object instead of text |
| `cwd` | absolute path | Tools and gates work here; configuration stays in the parent project. Gates use the SDK-observed execution directory, including a copied monorepo subdirectory before cleanup. Cannot be changed on resume |
| `taskAssignment` | TaskAssignment v1 | Optional exact retained-workspace binding; supply the exact `agentType`, approved configuration, scope and initial source identity. No fallback or stock worktree isolation |

Any other key is rejected **by name** at the call. Note that this checks option *keys*, not option *values* — an ordinary `agentType` that names no known agent falls back to `general-purpose` silently. Task assignments refuse fallback and validate the complete versioned contract host-side.

One-shot profiles (`dispose_on_consume: true`) retain their final `.output` transcript before the blocking workflow result releases the SDK session, subject to the selected profile's `output_transcript` override and project/global default. The file survives record eviction until temp storage is swept; `output_transcript: false` opts out. These children cannot resume. Unconfirmed session cleanup is reported once per actual spawn/resume result in the progress log as `<label>: Session cleanup not confirmed: …`, without changing the answer, schema payload or child success/failure/skip status.

A one-shot profile with effective `isolated: true` rejects `schema` before worktree or SDK/provider startup: `StructuredOutput` would broaden its built-in-only scope. Use text results for the restricted research template. Ordinary profiles and non-isolated one-shot profiles still support schemas.

Combination rules: `resume` cannot be combined with `agentType`, `model`, `effort`, `isolation`, `cwd`, `gate` or `schema` — a resumed child keeps the agent type, model and tree it was started with, and its session predates the `StructuredOutput` tool.

#### Task-bound receipts

Use `agent(prompt, { agentType: args.assignment.profile, taskAssignment: args.assignment })`; [the complete contract/receipt reference](../README.md#bound-task-assignments-and-receipts) describes required fields and helper-produced fingerprints. Work happens in the retained assigned workspace without automatic staging, commits, branches or removal. This metadata does not approve work or hard-confine tools. The manager validates startup, settlement and resume observations; external writers remain the caller's responsibility.

`agent()` still returns text, a schema object or `null`. Task results add immutable `taskAssignment`/`receipt` metadata to host spawn/resume outcomes and the final `runWorkflow()` result's optional `receipts` array. The existing workflow task retains that array and adds it to completion notification `details`; text/schema/null values remain unchanged. A standalone `taskAssignment` does not enable the `task` facade. Requirements listed in a receipt are not proof checks ran, and neither successful text nor a completed status proves candidate scope, SDK release, independent review or merge approval.

For task resume, pass `agent(prompt, { resume: label, taskAssignment: freshAssignment })`; only `attemptId` may differ, within `maxRemediations`, and the actual retained session must already have settled. Disposable profiles still cannot resume. A task gate must exactly match `approvedChecks` and requires the `check` action; it runs in the assigned cwd via the existing gate mechanism, not a new deterministic checkpoint API.

Task `agent()` calls never reuse generic journal answers: they break prefix replay and execute live, so old text cannot stand in for source writes or current lifecycle observations. That is **not safe checkpoint recovery** and does not authorize replaying interrupted authoring; the caller must revalidate authority, binding and writer settlement before a fresh assignment. The [saved Direct recipe](#serial-direct-implementation) uses the opt-in facade below, not standalone assignment/journal replay.

### Opt-in TaskPlan facade

Supply `taskPlan: { version: 1, builder, reviewer }` to `SubagentWorkflow`; each role is a complete externally approved TaskAssignment. Builder uses role `Builder`, read/write/check actions and at least one exact approved check. Reviewer uses role `Reviewer`, read without write, and `inheritContext:false`. Both agree on task/authority references, initial binding, protected baseline and remediation limit; Reviewer source scope cannot widen Builder scope. Profile files, instruction bytes, parent/global settings and actual model/effort/restrictions are revalidated. Configuration roots remain the parent's, not the assigned SDK workspace.

Only this route gets `task`; ordinary scripts gain neither it nor Node/fs/shell globals. Every worker must consume a prepared contract. Gates, ordinary-worker downgrade, stock worktrees and UI retry are refused on this route; repair goes through the bounded `reopen` operation.

| Method | Behavior |
|---|---|
| `await task.prepare('builder' \| 'reviewer')` | Fresh attempt ID and current initial source binding derived solely from the predeclared contract. Reviewer can start only after freeze and is always fresh/non-authoring |
| `await task.prepare('builder', {resume: label})` | After authorized bounded reopen, retain the last Builder's entire original contract except a fresh attempt ID. Use the same current-author `agent(..., {resume: label, taskAssignment})` handle within this run; no recovered conversation is invented |
| `await task.check(command)` | Exact approved command in canonical retained workspace using existing gate shell/`pi.exec`, 10-minute default timeout and killed handling. Known workers must have actual settled/quiescent receipts and live SDK idle observations. Returns code/killed, before/after fingerprints, at most 8,000 diagnostic characters and a full private artifact; no verification model. Retrying a failed command requires bounded reopen first; unawaited/aborted checks are cancelled through exec's signal |
| `await task.freeze()` | Require all approved checks passing on exactly the current settled author's source. Records private exact source evidence (HEAD/branch/index/tracked/untracked/type/mode/symlink); no staging, write-tree, commit or cleanup |
| `await task.recordReview(verdict)` | Require the actual fresh independent Reviewer's structured output and receipt on this exact frozen candidate. Reobserve source after review; arbitrary script verdicts or model SUCCESS cannot pass |
| `await task.reopen(reason)` | Only after a failed check or COMPLETE Reviewer rejection; consume one shared `maxRemediations`, invalidate old checks/freeze/review, permit only in-scope repair. Fresh workers and checkpoint recovery do not reset the count. The latest reason, source fingerprint and count are retained in the private checkpoint projection |
| `await task.checkpoint()` | Save a versioned run-local observational projection through parent `pi.appendEntry`, returning a checkpoint ID/private artifact and safe step |

Fresh workers use the prepared profile and assignment: `agent(prompt, {agentType: assignment.profile, taskAssignment: assignment})`. The host forwards declared model, thinking, maxTurns, isolated and inheritContext without silently substituting defaults. `agent()` retains its text/schema/null return, normal usage and budget accounting. Run/notification metadata add `taskProjection`; none of these observations grants acceptance or merge/publication authority.

Task admission and operation boundaries refuse known Manager-owned running, queued, stopped-but-unsettled or SDK-busy workers in the same canonical Git checkout, including ordinary workers. Repository root, child/sibling directories, symlinks and configuration directories share checkout identity; distinct Git worktrees do not. Planned bindings survive queueing and abort. This is Manager-scoped exclusion, not external-process containment. Settled/quiescent `steered` authors may proceed to checks/freeze without rewriting their receipt status or claiming task acceptance.

On script return/error or cancellation, the runtime stops admission, requests cancellation, terminates the worker VM and drains only this Task's checks and agent operations. Abort delivery is not settlement: successful public completion and checkout release require settled owned promises and current Manager/SDK idle, compaction and Bash observations. A three-second settlement timeout returns failure (or preserves an existing killed/failed outcome) with `taskProjection.ownership.state: 'unconfirmed'`, not release. The parent records `subagents:task-ownership-unconfirmed`; all parent-session entries are checked so selecting another branch cannot hide it. Late settlement does not automatically clear that barrier. Human-owned settlement/handoff is required; no automatic clearance/reassignment API is supplied.

Workflow startup validates script metadata, length and control characters before constructing the host or acquiring recovery retention leases; rejected scripts leave existing worker retention unchanged. Run-scoped Manager retention keeps current Task workers available through long checks/review and completed-record sweeps. Confirmed checkout release drops that run's retention; unconfirmed ownership keeps it. Ordinary settled records still use normal ten-minute eviction. Missing/expired records are never reconstructed from persisted receipts. Ownership release is distinct from SDK-session disposal: ordinary resumable Task sessions may remain retained.

Reviewer output must match this object contract (use `schema` on its fresh `agent` call):

```text
{ version: 1, status: 'COMPLETE', candidateFingerprint: <exact freeze fingerprint>,
  verdict: 'PASS' | 'REJECT', summary: <nonempty text>,
  findings: [{ id, severity: 'P0' | 'P1' | 'P2' | 'P3', path, description }] }
```

Unknown fields, missing/incomplete output, stale fingerprints, duplicate finding IDs and inconsistent verdict/findings are refused. PASS requires no findings; REJECT requires at least one. The submitted verdict must equal the actual Manager-recorded structured output, not copied prose. Reviewer session identity must differ from every Builder session, and its attempt number must be 1.

Artifacts are unique mode-0600 files beside existing parent task output, never inside source. Check/freeze/review and worker-evidence snapshots retain byte identities. `recoveryCheckpointId` reconstructs only `ctx.sessionManager.getBranch()`, refuses stale checkpoints with later observations, and revalidates exact plan/input/configuration/baseline/current source, artifact bytes and CURRENT Manager/SDK settlement. A registered public recovery invocation has a new workflow task ID and retention lease; its restored projection keeps the original checkpoint's `runId` lineage. Safety ownership barriers are tree-wide observations, not selected-branch recovery authority. It can continue known-safe built/checked/frozen/reviewed/reopened observations without replaying completed writes. Pending/interrupted/prepared/checking projections, missing or expired workers, discarded branches, configuration drift and cross-parent sessions block for a Human-owned handoff/reassignment; persisted receipts never prove idle by themselves. There is no process registry or automatic reassignment. External writers and arbitrary Bash/MCP effects are not contained by this facade.

`resumeFromRunId` refuses this mutable route (including attempts to resume it without supplying TaskPlan); ordinary replay remains unchanged. The [saved Direct recipe](#serial-direct-implementation) has synthetic integrated coverage through this public route, real SDK children and local checks with scripted provider answers. Actual-provider and staged-host SDK qualification remain separate; synthetic call counts are not billing or timing gains.

### `pipeline()` and `parallel()`

```js
await pipeline(items, ...stages)   // no barrier between stages
await parallel(thunks)             // barrier: waits for all of them
```

**`pipeline` has no barrier.** Item A can be in stage 3 while item B is still in stage 1, so the total time is the slowest single *chain* rather than the sum of the slowest per stage. Each stage receives `(previousResult, originalItem, index)` — the original item and its index stay available in later stages, so you do not have to thread them through the return value. A stage that throws drops that one item to `null` and skips its remaining stages.

**`parallel` is a barrier.** It waits for everything before anything moves on, so if five agents run and the slowest takes three times the fastest, four sit finished doing nothing. A thunk that throws becomes `null` without taking its siblings down.

Prefer `pipeline` unless a stage genuinely needs every prior result *together* — deduplicating across the whole set, deciding whether to continue at all, or a prompt that compares one result against all the others. Needing to flatten, map or filter is not such a case; do that inside a pipeline stage.

### `workflow(nameOrRef, args?)`

Runs a saved workflow inline and returns its value. Pass a name, or `{ scriptPath }`. `args` becomes the child's `args` global.

The child runs in the *same* worker and vm context under its own globals, so it shares this run's concurrency cap, agent counter, abort signal, journal and budget by construction — its agents are simply this run's agents, controllable from the same inspector. What it does not share is phase state: the child's phases render as their own `▸ <name>` group.

**One level only** — `workflow()` inside a child throws saying so. An unknown name, an unreadable path, a child carrying no `meta`, or a child that will not parse all throw into the calling script, so `try`/`catch` if you want to handle them. Capped at 256 nested calls per run.

### `phase()`, `log()`, `args`, `budget`

- **`phase(title)`** — start a new progress group; subsequent `agent()` calls are grouped under it. Inside `pipeline`/`parallel` stages use the `phase` *option* instead, since the ambient phase races.
- **`log(message)`** — a progress line under the tree, for you to read.
- **`args`** — whatever was passed as the tool's `args`, verbatim; `undefined` if none.
- **`budget`** — `{ total, spent(), remaining() }`. **`total` is always `null` here**: it comes from a token-target directive pi does not have. That is deliberate rather than broken — Claude Code scripts guard on it (`while (budget.total && budget.remaining() > 50_000)`), and those guards correctly do not fire instead of throwing on a missing global. `remaining()` is `Infinity` with no target. `spent()` is real, and counts output tokens this run's agents have used.

### Where files live

| What | Where |
|---|---|
| An inline script, as run | `<tmp>/pi-subagents-<uid>/<encoded-cwd>/<session>/tasks/<run id>.workflow.js` |
| The resume journal | the same directory, `<run id>.workflow.jsonl` |
| Saved workflows | `.pi/workflows/` → `.agents/workflows/` → `<agent dir>/workflows/`, first hit wins |

The first two are scratch: temp storage, wiped by a reboot or a temp sweep. Only the third is durable, and copying a script there is a manual step.

### Limits and caps

| Limit | Value |
|---|---|
| Agents running at once | `max(1, min(16, cpus - 2))` — 6 on an 8-core machine |
| Agents per run, total | 1000 |
| Items per `parallel`/`pipeline` **call** | 4096 |
| Nested `workflow()` calls per run | 256 |
| Script length | 512 KiB |

These are three different things and are easy to conflate: 1000 is a budget for the whole run, the concurrency figure is how many run *simultaneously*, and 4096 is per call rather than per run. Excess items queue rather than melting the machine.

Above 25 scheduled agents, or 1.5M tokens actual or projected, the card adds `⚠ Large workflow · /agents → Workflows to stop`.

A run's concurrency limit is its own, independent of the session's `maxConcurrent` and `maxConcurrentForeground` pools — its agents do not enter either.

### Settings and the CLI flag

`workflowsEnabled` is **on**; leaving it unset means *auto*, which is on unless another extension already offers a `Workflow` or `SubagentWorkflow` tool, in which case this one stands down for the session. Setting it explicitly pins it. See [Persistent settings](../README.md#persistent-settings).

`pi --subagents-workflow-file=<path>` runs a workflow at startup, including headless under `pi -p`. Use the `=` form — the bare `--flag value` spelling swallows the next argument. See [CLI flags](../README.md#cli-flags).

## Recipes

The orchestration patterns themselves — adversarial verification, judge panels, loop-until-dry — live in exactly one place: the tool description the model reads on every turn. It already knows them. So these are not instructions for writing scripts by hand; they are **what to ask for**, and what the resulting script looks like so you can recognize it in the file.

### Serial Direct implementation

[`direct-implementation.js`](../examples/workflows/direct-implementation.js) consumes a caller-approved TaskPlan; it invents no authority, role, model or effort. Invoke `SubagentWorkflow` with `scriptPath: 'examples/workflows/direct-implementation.js'`, `taskPlan: {version: 1, builder, reviewer}` and `args: {task: '<bounded implementation and acceptance instructions>'}`. These are complete assignments, not role names; use the [contract reference](../README.md#bound-task-assignments-and-receipts) to declare them before execution. Copy the example into a project workflow directory for named discovery; it is not auto-installed.

Fresh Builder -> every exact approved local check -> freeze -> fresh schema-bearing non-authoring Reviewer. Actual failure diagnostics or COMPLETE REJECT findings trigger host-bounded reopen, a fresh scoped Builder, all checks/refreeze and a new Reviewer. Missing/malformed/incomplete outputs fail; no verification-model call or silent PASS. The host's shared `maxRemediations` survives workers and recovery. Results include locally-ready-for-human status, candidate/check/review/checkpoint artifacts and actual per-attempt model/effort/usage/SDK disposition. Full receipts/evidence remain in the private checkpoint/projection. No merge approval, publication, installation or cleanup.

For a known-safe continuation, pass the same TaskPlan, `recoveryCheckpointId` and `args: {task: '<same instructions>', continueFromCheckpoint: true}`. This flag asks the recipe to read `task.checkpoint()` after host recovery; it is not evidence or a replacement for that ID. The actual safeStep controls continuation: built/checked skips recorded checks, frozen starts only a fresh Reviewer, reviewed processes the actual verdict, reopened supplies the exact persisted remediation reason to a fresh Builder before preparing it. Reopened legacy checkpoints without valid source/count-bound repair context refuse continuation and require a Human-owned handoff. Completed Builder writes are not replayed. Missing current writers, interrupted steps and drift remain host refusals; no `resumeFromRunId` or invented conversation handle.

Synthetic qualification in `test/e2e/direct-implementation.e2e.test.ts` runs the actual saved file through the registered public tool and worker VM, real Manager/SDK/tool execution and real local checks. Host API/context and model registry/auth are fixture mocks; provider answers are scripted. It measures child starts separately from provider calls; it does not establish actual-provider reliability, staged SDK compatibility or efficiency/billing gains.

### Fan out over a list you don't have yet

> *"audit every route file under src/routes for missing auth checks"*

One discovery agent, then `pipeline` over what it returned. Recognize it by: a lone `await agent(...)` producing a string, a `.split('\n')`, then `pipeline(files, …)`.

See [`fan-out-audit.js`](../examples/workflows/fan-out-audit.js).

### Get objects back instead of prose

> *"…and give me the results as structured data I can sort by severity"*

Recognize it by a `const SCHEMA = { type: 'object', … }` near the top and `schema: SCHEMA` on the `agent()` calls. Worth asking for whenever the script has to *do* anything with the results rather than hand them to you.

See [`structured-findings.js`](../examples/workflows/structured-findings.js).

### Verify by running, not by asking

> *"fix it, and don't report success unless `npm test` passes"*

Recognize it by `gate: 'npm test'` on the fix agent. An LLM judging whether a fix works is a weaker signal than the test suite; this is the difference between a result that is *verified* and one that is merely *claimed*.

See [`gated-fix.js`](../examples/workflows/gated-fix.js).

### Keep an agent's context instead of re-paying for it

> *"if the tests still fail, tell the same agent what broke and let it try again"*

Recognize it by `label: 'fix'` on the first call and `resume: 'fix'` on the second. A gate-rejected child stays resumable, which is what makes "here is what the tests said, fix it" a loop rather than a fresh start.

Also in [`gated-fix.js`](../examples/workflows/gated-fix.js).

### Several opinions, then a synthesis

> *"review this from a correctness, security and performance angle, then reconcile them"*

This is the case where a barrier is *earned* — the synthesis agent's prompt genuinely needs every review at once. Recognize it by `parallel([...])` followed by a single `agent()` that interpolates all of the results.

See [`review-panel.js`](../examples/workflows/review-panel.js).

### Reuse a workflow inside another

> *"map the repo first, then run the audit against what it found"*

Recognize it by `await workflow('repo-map', { … })`. Reach for it to reuse something already saved, not to structure one script — inline composition is cheaper.

See [`compose.js`](../examples/workflows/compose.js).

## Troubleshooting

**The run failed with `… is unavailable in workflow scripts (breaks resume)`.**
The script called `Date.now()`, `new Date()` or `Math.random()`. A script that varies run to run cannot be replayed from its journal, so these throw. Use the loop index for ids, pass timestamps in through `args`, or stamp them after the workflow returns. This most often bites pasted-in helper code, and it throws at the line that calls it — *after* you have already paid for the preceding agents.

**`The meta object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation.`**
`meta` is evaluated before the script runs, in an empty context, so it cannot reference anything. Move the dynamic part into the body.

**`agent() opts.<key> is not a recognised option.`**
A typo, or an option from a different tool. The supported set is `label`, `phase`, `model`, `agentType`, `isolation`, `gate`, `resume`, `effort`, `schema`.

**An agent ran as the wrong type and nothing said so.**
An `agentType` that names no known agent falls back to `general-purpose` **silently** — unlike the `Agent` tool, which tells you. Option *keys* are validated; option *values* are not. Check the spelling against `/agents`; matching is case-insensitive, and a disabled agent does not count.

**`agent()` returned `null`.**
The agent failed terminally, or you skipped it with `s` in the inspector. These are indistinguishable to the script. With `schema`, it also covers a child that never produced a payload matching the schema.

**A `schema` call came back as `null` even though the agent clearly answered.**
`schema` is pressure, not a guarantee. The child gets a `StructuredOutput` tool, `constrainedSampling` set to `strict: "prefer"`, and a validation-and-retry round trip — three soft pressures, where Claude Code has one hard one (it can force the tool call; this cannot, because `toolChoice` is not plumbed through pi's `AgentSession`). Keep schemas small and flat, and `.filter(Boolean)` after every schema stage.

**The run failed complaining about an un-awaited `agent()`.**
A dropped `await`, usually inside a `pipeline` stage. The run would otherwise finish while children were still working and throw their results away, so ordinary workflows fail immediately rather than draining. TaskPlan runs instead use the bounded owned-effect drain above; an ignored abort or uncertain SDK observation leaves checkout ownership unconfirmed, never released.

**`Cannot run with isolation: "worktree"`.**
Not a git repo, no commits yet, or `git worktree add` failed. Isolation is a strict guarantee rather than a hint, so it fails loudly instead of quietly running in your main tree. Initialize git and commit at least once, or drop the option.

**`No saved workflow named "x". Looked in: …`**
The file is not in any of the three directories, or it is there but carries no `export const meta =` declaration, so it is not recognized as a workflow. The message lists the directories it searched and any workflows it did find.

**The run seems stuck with agents queued.**
Concurrency is capped at `max(1, min(16, cpus - 2))`. Queued agents start as slots free. A pause (`p`) also holds new starts while letting running agents finish.

## What workflows can't do

- **No filesystem, network or module access inside the script.** All real work happens in the agents it spawns, which have their normal tools.
- **No `eval` or `Function(...)`** — code generation is off in the vm; they throw `EvalError`.
- **No cross-session resume.** Journals are per session.
- **No resume at all for `--subagents-workflow-file` runs** — that path never journals.
- **No UI that lists or launches saved workflows.** The inspector shows this session's runs.
- **No scheduled workflows.** The scheduler runs agents, not workflows.
- **Results are not persisted** beyond the journal and the transcript card.
- **No driving one from another extension.** A workflow cannot be started or steered over the `pi.events` bus, and its agents are invisible to the RPC surface — they emit no lifecycle events, and `subagents:rpc:stop` refuses them. See [`rpc.md`](rpc.md).

The sandbox is a determinism and accident boundary, not a defence against a deliberately hostile script: the injected globals are host closures, and disabled code generation is what actually stops one being used to compile anything.

## Coming from Claude Code

This is a port of Claude Code's `Workflow` tool down to its state model, so **a script written for Claude Code runs here unchanged.** `test/workflow-claude-code-compat.test.ts` runs the canonical `review-changes` example from that tool's own description, verbatim.

Identical: `agent()`, `pipeline()`, `parallel()`, `workflow()`, `phase()`, `log()`, `args`, `budget`; the `meta` block; `schema` returning a validated object; one-level `workflow()` nesting; the determinism throws.

Different:

- The tool is **`SubagentWorkflow`**, not `Workflow` — pi's tool registry is flat across extensions, and the winner of a name clash also overwrites the loser's description.
- **`budget.total` is always `null`**, because pi has no token-target directive. Claude Code's `budget.total`-guarded patterns therefore run unchanged, just without firing.
- **`schema` is pressured, not forced** — see the troubleshooting entry above.
- If both extensions are loaded, this one **stands down** rather than offering the model two orchestrators.

Additions on this side: `gate`, `resume`, `effort`, journal-backed `resumeFromRunId`, and the un-awaited-`agent()` check. All are optional, which is what keeps a Claude Code script portable.

## Examples

Ordinary examples run against a stub host in `test/workflow-examples.test.ts`; the task-bound Direct recipe runs through the public route in `test/e2e/direct-implementation.e2e.test.ts`.

| File | Demonstrates | Runs as-is? |
|---|---|---|
| [`direct-implementation.js`](../examples/workflows/direct-implementation.js) | Approved serial Builder/check/freeze/fresh Reviewer, bounded repair and checkpoint continuation | Requires TaskPlan and `args.task` |
| [`fan-out-audit.js`](../examples/workflows/fan-out-audit.js) | Runtime fan-out, `pipeline`, `label`, per-stage `phase` | Yes — takes `args.root` |
| [`structured-findings.js`](../examples/workflows/structured-findings.js) | `schema` on both stages, objects instead of prose | Yes |
| [`gated-fix.js`](../examples/workflows/gated-fix.js) | `gate`, `isolation: "worktree"`, `resume` retry loop | Needs a real test command |
| [`review-panel.js`](../examples/workflows/review-panel.js) | An earned `parallel` barrier, `effort` tiering, `model` | Yes |
| [`compose.js`](../examples/workflows/compose.js) | `workflow()` nesting and `args` plumbing | Needs `lib/count-child.js` saved |

Copy one into `.pi/workflows/` to make it yours.
