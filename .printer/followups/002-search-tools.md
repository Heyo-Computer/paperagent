# Follow-ups for /home/sarocu/Projects/todo/specs/002-search-tools.md

Generated: 2026-05-31T18:18:24.865638618+00:00
Verdict: PARTIAL

## Suggested follow-ups

- Drive the running Tauri app (with backend + key) on a real display to confirm the `/search` menu and live chip navigation for todo/artifact/list/book actually land on detail views.
- Make backlog-todo chip navigation select/scroll to the item, not just switch tabs (`store.ts:73-78`).
- Split the unrelated books/lists/marketing/BlockNote changes onto their own branch/spec so this search work can be reviewed and merged independently.
