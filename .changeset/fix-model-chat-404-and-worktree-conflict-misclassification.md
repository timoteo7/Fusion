---
"@runfusion/fusion": patch
---

summary: Fix "Failed to create chat session" on model chats, and tasks wrongly failed as branch conflicts.
category: fix
dev: Chat — FN-8869 hoisted the agent-existence check out of its `else` branch in `register-chat-routes.ts`, so model-target chats sending the agent-less `__fn_agent__` sentinel 404'd; the agent is now required only when it is the source of model resolution. Self-healing — a failed `tip-already-merged` cleanup was rethrown and classified `branch-conflict-unrecoverable`, failing and pausing tasks whose branch was already an ancestor of the integration ref (every observed case was a `git worktree remove --force` / `ENOTEMPTY rmdir node_modules` pnpm race). Cleanup failure now retries on the next sweep, and `git worktree prune` runs before removal so stale registrations stop causing the failure they would have prevented.
