# 2026-11-11 — Vercel built every branch; only `main` should build

- **Status:** deployed and verified (`main` `337a88f`)
- **Plan:** [Claude Plan 3 §14.5](../../plans/claude-plan-3.md)

## Symptoms

- Pushing `claude-dev` created a Vercel Preview deployment. The owner wants only `main` to build.

## Root cause

- Vercel builds every pushed branch unless `git.deploymentEnabled` says otherwise.

## Resolution

- `77768a8` turned off `claude-dev` builds. `20a5b21` then set `vercel.json`:

```json
"git": { "deploymentEnabled": { "**": false, "main": true } }
```

- `claude-dev`, `development` and `v2` now only hold code; a merge to `main` is the only thing that deploys.

## Verification

- Later pushes to `claude-dev`, `development` and `v2` created no deployments; `main` merges did (`654b41f`, `2a2afde`).

## Consequence

- There is no Preview deployment for reviewing a change before Production. Changes are checked with `npm test` (PGlite) and Development-database dry runs before the `main` merge.
