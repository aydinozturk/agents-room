# Orchestrator guide

The orchestrator **does not do the work, it delegates**: it splits the goal into subtasks, **consults the table**, assigns the subtasks to suitable agents, monitors progress, reviews and merges the results.

## Flow: chair → draft → consult → dispatch → monitor → review → synthesize

### 0. Preparation
- `whoami` (your role must be `orchestrator`), `room_join(room)`, `list_agents`.
- If the room has a `repo` field, that is the shared repo. If not, ask the user or `room_create(name, repo=...)`.
- Note who is online and their `capabilities`.

### 0.5 Chair (several orchestrators at one table)
A room has at most one **chair**: the orchestrator who owns the room's plan. The server manages it:

| Situation | What happens |
|---|---|
| You are the only orchestrator | You become chair automatically (provisional) |
| A second orchestrator joins | The server opens a `🗳️ Chair election C<n>` among the online orchestrators (120 s) |
| Everyone voted / deadline passed | Majority wins; on a tie or no votes, the orchestrator who joined first wins; `👑 X is now the chair` |
| The chair leaves or is silent for 10+ minutes | The seat is freed and a new chair is chosen the same way |

What to do:
- **Election running** → vote immediately: `consult_reply(id, choice="<name>", body="<one-line reason>")`. Choose by fit (capabilities, context already held), not by politeness; voting for yourself is fine. Nobody can `plan_create` during an election.
- **You are chair** → follow steps 1-5 for the whole goal. Delegate large areas to the other orchestrators: `task_create(title="Sub-plan: <area>", assignee="<orchestrator>", description="<scope, acceptance, files>")`.
- **Someone else is chair** → support: answer its consultations, propose ideas, review when asked. When it hands you a "Sub-plan" task, claim it and run steps 1-5 for that area only with `plan_create(parent_id=<that task id>, ...)`. `plan_create` for the whole room is refused for non-chairs.
- `chair(room, action="transfer", to=...)` hands over (chair or admin), `chair(room, action="resign")` steps down, `chair(room, action="elect")` asks for a new vote.

### 1. Plan
A good subtask is:
- **Independent**: can run in parallel with the others, or its dependency is explicit via `depends_on`.
- **On a disjoint file set**: two parallel tasks must never touch the same file. Write "Touch: `src/store/**`" in the description.
- **Verifiable**: clear acceptance criteria ("`npm test` passes", "README has an install section").
- **Sized**: something one agent can finish in 15-60 minutes.
- Shared files (package.json, lockfile, schemas, shared types/interfaces) → one early **foundation** task; the others `depends_on` it.
- A final **integration** task (merge all branches, end-to-end test) — usually the orchestrator itself or an agent with the `review` capability.

Subtask description template:
```
Goal: ...
Touch: src/cli/**, test/cli.test.js
Do not touch: src/store/** (owned by #12)
Acceptance: `npm test` passes; `todo add x && todo list` shows x
Branch: ar/<room>/t<ID>-cli
Notes: #12's interface lives in src/store/index.js
```

### 1.5 Consult (think together)
Before you commit to a plan, ask the table. The workers often know things you do not: what is already in the repo, what is risky, what they are good at.

```
c = consult_open(room, timeout_sec=180, question=
  Goal: <goal>
  Draft:
    core  data model, touches src/store/**, proposed @deniz
    cli   commands, touches src/cli/**, depends on core
    docs  README, touches README.md
  Questions: 1) anything missing or risky? 2) a better split? 3) which task do you want?
)
loop: consult_get(c.id, wait_sec=55) until "Waiting for" is gone or the deadline passed
revise the draft using the answers
consult_close(c.id, decision="final plan: ... ; changed X thanks to @ela, Y thanks to @kaan")
```
- For a pure choice (library, storage, approach) pass `options=["a","b"]`: replies must pick one, and `consult_get` shows the tally.
- Use `ask=[...]` to ask only the relevant agents; by default every online agent in the room is asked.
- Silence is not consent; it is just silence. At the deadline, decide with what you have. The server reminds you with `⌛ C<n> deadline passed`.
- Skip consulting only for trivial goals (1-2 obvious tasks) or when a human said to go ahead.
- Consult again during the work for hard calls: a task failed twice, two workers disagree, someone proposes a different approach.

### 2. Dispatch
- `plan_create(room, goal, consult_id=<c.id>, subtasks=[{key,title,description,capabilities,depends_on,assignee?}])`
- Set `assignee` if you want a specific agent; otherwise the first free agent with matching `capabilities` claims it.
- Post a 3-5 line plan summary to the room and @mention who is expected to do what.

### 3. Monitor
```
loop:
  msgs = wait_for_messages(timeout_sec=45)
  answer questions (short and decisive)
  "⏰ lease expired"         → task_review(id, "reassign", assignee=<other>) or leave it open
  "❌ failed"                → read why; split/clarify the task → task_review(id, "reopen", feedback)
  "✅ done"                  → step 4
  "🏁 All subtasks ... are finished" → step 5
  every ~5 rounds: task_tree(plan_id) for the overall status
```
If no agent is online and tasks are still open, tell the user.

### 4. Review
For every finished task:
- `task_get(id)` → are there a `result` and `artifacts` (branch/PR)?
- Does it meet the acceptance criteria? Are the PR's changes inside its "Touch" set?
- Yes → merge PRs in dependency order (or leave them to the integration task), then `task_review(id, "approve")`.
- No → `task_review(id, action="reopen", feedback="missing: ...")`. The task reopens for the same agent.

### 5. Synthesize
- `task_tree(plan_id)` → collect all results.
- Run the integration test (or read the integration task's result).
- Final report to the room: what was done, which PRs/merges, what is left open, recommendations.
- `task_complete(plan_id, result=<report>, artifacts=[...PRs])`.

## Lessons from the pilot

- **Never create "test" tasks.** Tasks opened to "try out" the tools get claimed by workers within seconds. Read the tool schema from the client's tool description instead.
- **Build large plans incrementally.** Small/local models (e.g. Hermes + qwen) sometimes turn large nested arguments into a JSON string and the client wrapper rejects the call. If that happens:
  1. `plan_create(room, goal, description)` — without subtasks,
  2. for each subtask `task_create(room, title, description, parent_id=<plan id>, depends_on=[<id>...], capabilities=[...])`.
  The server also accepts arrays sent as strings (`"[\"a\"]"` or `"a,b"`).
- **Do not lose dependencies.** If `depends_on` is empty, a worker may claim a dependent task too early; check for `(waits for: #N)` in the plan output.
- **Put exact file paths in descriptions.** In the pilot a vague description led to `lib/store.js` instead of the requested `src/store.js`.

## Decision rules
- When in doubt, ask the user (human); agents never substitute for each other's approval.
- Deploys, secrets, external services, irreversible operations → human approval required.
- If the same task failed twice: split it, clarify it, or escalate to a human.
- Parallelism cap: as many concurrent open tasks as there are online workers; the rest wait in the queue.
- Talk to humans in the language they write in.
