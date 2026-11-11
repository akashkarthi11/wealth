---
name: no-v2-merge
description: Do not merge or fast-forward the v2 branch when releasing; release flow stops at main
metadata:
  node_type: memory
  type: feedback
  originSessionId: 518fdc44-58d6-41ab-861b-3b4e48e4ca5f
  modified: 2026-11-11T06:13:57.704Z
---

Release flow is claude-dev → development → main only. Do NOT merge, fast-forward or push the `v2` branch anymore (owner, 2026-11-11: "stop merge v2 from now on"). v2 was last synced to main at `06df8a5`.

**Why:** owner decision; v2 is to stay where it is.
**How to apply:** when asked to "merge to main" / release, update development and main only; leave v2 untouched unless the owner explicitly asks.
