# Multiple agents in a shared repo: git rules

Goal: several agents work **in parallel** in the same GitHub repo without overwriting each other, conflicts surface early, and every change is traceable to a task.

## 0. Base branch and credentials

- The rules below say `main`; if your launch prompt names a different base branch (e.g. `master`), use that one everywhere instead.
- Your clone is already authenticated for `git fetch/pull/push` to `origin` (a credential helper reads the key from the environment). Never print, echo, log, commit or paste credentials or environment variables, and never put a token into a remote URL.
- If `gh` is available, open PRs with `gh pr create --base <base> --title "[#<ID>] <title>"`. Without `gh`, push your task branch and report it as the `branch` artifact; the orchestrator merges it.

## 1. Workspace: a separate worktree per task

```bash
git fetch origin
git worktree add ../$(basename $PWD)-<agent>-t<ID> -b ar/<room>/t<ID>-<slug> origin/main
cd ../$(basename $PWD)-<agent>-t<ID>
```
- If several agents share a machine, each works in its own worktree; nobody edits the main clone.
- Separate clones on separate machines are already isolated; the rule is still one owner per branch.
- When done: `git worktree remove ../<dir>`.

## 2. Branch name

`ar/<room>/t<ID>-<short-slug>` — e.g. `ar/pilot-todo/t12-store`
- The branch has **one owner**: the agent that claimed the task. Nobody else pushes to it.
- If the task is reassigned, the new owner may continue on the same branch (`git fetch && git switch <branch>`); the previous owner stops touching it.

## 3. File reservations (advisory locks)

Before you start editing:
```
files_reserve(repo="github.com/org/project", paths=["src/store/**","test/store.test.ts"], task_id=<ID>, reason="#<ID> storage")
```
- On conflict **do not touch those files**. Options: `send_message(to=...)` the holder, tell the orchestrator, take another task.
- Before committing, check again with `files_check(repo, paths=<git diff --name-only>)`.
- Shared files (package.json, lockfile, CI config, migrations, shared types): `exclusive=true` and for as short as possible.
- `task_complete` / `task_fail` release the task's reservations automatically.

## 4. Commits

- Small, meaningful commits; conventional commits recommended: `feat(store): json file store`.
- Every commit message ends with these trailers:
  ```
  Task: #12
  Agent: codex-mac2
  ```
- Never commit generated files (build output, node_modules).

## 5. Sync and push

```bash
git fetch origin
git rebase origin/main          # rebase instead of merge commits
<run the tests>
git push -u origin ar/<room>/t<ID>-<slug>        # after a rebase: --force-with-lease (ONLY on your own branch)
```
- **Never**: push directly to main, `--force` without lease, push to someone else's branch, wipe shared state with `git reset --hard`, skip hooks with `--no-verify`.

## 6. Pull requests

- One PR per task. Title: `[#<ID>] <task title>`.
- Body: task summary, changed files, verification steps, known limitations.
- `task_complete(..., artifacts=[{type:"branch",ref:"ar/..."},{type:"pr",ref:"https://github.com/..."}])`.
- If `gh` is not available, the branch artifact is enough; the orchestrator opens/merges.

## 7. Merging and conflict handling

- The **orchestrator/integrator** merges, in dependency order (foundation task → the ones built on it).
- Squash merge recommended (one task = one commit on main); keep the trailers.
- If a merge conflict appears:
  1. The integrator does not resolve it; it hands the task back with `task_review(action="reopen", feedback="conflicts with origin/main: <files>")`.
  2. The owner runs `git fetch && git rebase origin/main`, resolves the conflict, runs the tests, pushes with `--force-with-lease`, and calls `task_complete` again.
- Lockfile conflicts: never merge by hand — take main's lockfile and regenerate it (`npm install` / `uv lock`).
- If two tasks unavoidably need the same file, the orchestrator runs them **sequentially** (`depends_on`), not in parallel.

## 8. Recommended protections (repo settings — done by a human)

- Branch protection on `main`: PR required, green CI required, no force-push.
- CODEOWNERS for human approval on critical directories.
- A separate GitHub account / fine-grained token per agent: this repo only, `contents:write` + `pull_requests:write`, no `admin`.
