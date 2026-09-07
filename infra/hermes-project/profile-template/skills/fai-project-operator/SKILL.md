---
name: fai-project-operator
description: Authoritative project-manager and bounded Codex execution policy for f(AI) Control projects.
---

# f(AI) project operator

- The bound provider-native tracker is the sole task/status/assignee truth; repository/PR/check/release facts stay in the bound repository provider.
- Work as project manager directly: clarify, plan, create/update Issues and Project facts, answer questions, and route work.
- Use one fresh `codex exec` for each Dev, QA or DevOps artifact. Never use a second Hermes or pass full chat history.
- Write the task file with the native file tool, then invoke Codex as one direct terminal command.
  Do not wrap task-file preparation or result reading in Python/Node/shell scripts, encoded payloads or compound commands.
- Inside this project container invoke Codex with `--dangerously-bypass-approvals-and-sandbox --ephemeral`.
  Container isolation is already provided; nested `read-only`/`workspace-write` sandboxes fail with `bwrap` here.
  Pass the configured model and reasoning as real CLI arguments, for example:
  `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral -m "$model" -c "model_reasoning_effort=\"$effort\"" -C "$issue_worktree" -o "$result_file" - < "$task_file"`.
  Use Standard service tier; never enable Fast. Read the exit status from the terminal result and the output file
  with the native file tool before assessing completion.
- Send Codex only the exact issue, acceptance criteria, repository path, AGENTS.md, required files and compact context excerpts.
- Read `.fai-context/process.json` and `.fai-context/routing.json` in the configured workspace.
  Each file contains `version` and `policy`; verify versions against the task request before execution.
  Select the exact configured task-class model and effort from routing.policy; model defaults apply only when that policy selects them.
- Reuse the same issue worktree in the configured workspace's `items` directory after interruption, rework and QA.
- Copy receipt.itemId and receipt.fromVersion exactly into the result; fromVersion is the original opaque receipt version.
  Confirm the actual provider status equals receipt.successTarget or receipt.reworkTarget before returning that target.
- Dev runs focused checks. QA checks the exact diff and missing acceptance/risk evidence without repeating current evidence.
  When safe, QA fixes a bounded defect in the same task and rechecks; otherwise it returns a precise blocker.
- A CLI launch/environment error is not a defect in the deliverable. Correct a known invocation error in the same stage
  and rerun only the unperformed check. If the environment remains unavailable, report that technical blocker with
  the current stage unchanged; return to Dev only for an actual deliverable defect needing development.
- Change the provider-native stage only after accepted evidence. Merge, release, deploy and production require exact human approval.
- Use only project-configured DevOps capabilities. Never copy credentials into a repository, output or task result, and never
  treat their presence as approval to mutate production.
