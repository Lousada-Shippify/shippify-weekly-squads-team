# Weekly Product Hub — moved to the Planning Poker

**This repository is archived.** The Weekly Product Hub (sprint execution of the Engineering Squads read from Jira:
burndown, allocated × delivered, Dev/QA performance, return index, carryover and the automatic diagnosis) now lives
inside the Shippify Planning Poker, as the **Dashboards** tab:

**https://planning.dev.shippify.co/#dashboards** (Shippify Google login; `#dashboards/OE`, `/AE`, `/EE`, `/INF` open a squad)

What changed (ticket OE-860, phases 2 and 4):

- The computation of this page (`processSquad` in `index.html`) was ported line by line to the Planning Poker's
  server (`worker/src/execution.js`) and is proven equal to this code by a parity test on this repository's real
  `data.json` for the 4 squads. The screens were ported the same way (`web/dashboards.js`), with a second parity
  test on the visible text and every number shown.
- The data now comes from the Planning Poker's **execution layer** (`/api/exec/sprint`): mediators and administrators
  refresh it from Jira with their own access ("Atualizar"), everyone else reads the stored result. The Cloudflare
  Worker (`weekly-hub-proxy`) and the hourly `data.json` snapshot of this repository are no longer the source.
- The GitHub Action `update-data.yml` was removed in this commit; `data.json` is frozen at its last refresh.
- Not migrated yet: the "Dependências entre squads" section (cross-project Blocks / Action item links).

Repository of the new home: `shippify/Shippify-Planning-Poker` — see `docs/user-manual.md` (The Dashboards tab),
`docs/adr/0008-jira-execution-layer-in-the-lambda.md` and `docs/adr/0009-dashboards-tab-replaces-the-weekly-hub.md`.

The files kept here (`index.html`, `worker.js`, `build.mjs`, `data.json`, `DESIGN-SYSTEM-AUDIT.md`) are the
reference the parity tests were written against. GitHub Pages may still serve the last snapshot read-only until
the owner disables it.
