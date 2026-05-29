# Follow-ups for /home/sarocu/Projects/todo/spec.md

Generated: 2026-05-29T03:57:42.316197636+00:00
Verdict: PASS

## Suggested follow-ups

- Decide whether the in-app header should show "planner" or the VM name; if the former, drop the `agentName ← vm_name` coupling (`SettingsPanel.tsx:92,105`).
- For full consistency of the rename, update `package.json` `name`, bundle `identifier`, and `README` title (optional/cosmetic).
- Re-run the visual click-test on a host with a real Wayland compositor to confirm meter colors and heatmap rendering on-screen.
- The spec's 5 items landed in the same uncommitted tree as a much larger agent/Firecracker refactor — consider splitting commits so the spec work is reviewable in isolation.
