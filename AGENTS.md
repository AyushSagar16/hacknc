# hacknc — agent instructions

This is Atlas, a trip and money planner for iMessage group chats, built on [Spectrum](https://photon.codes/docs/spectrum-ts) (pinned to `spectrum-ts@^12.10.1`). The composition root is `src/app.ts`; `src/index.ts` and `scripts/live.ts` start it. Read `README.md` and `docs/architecture.md` first; memory design and trade-offs are in `docs/memory-research.md`.

## Working in this project

- `npm run live` runs Atlas on the real Linq line (tunnel + webhook subscription). `npm run sim` is a terminal group chat with no phones.
- Agent behaviour lives in `src/agent/prompts/system.md` (agent), `speak-gate.md` (whether to chime in) and `extract.md` (preferences). Money, constraints, polls and schedules are deterministic code; the models only do language, and every `$` figure the model writes must be registered (money guard).
- Before committing, run `npm run typecheck`, `npm test` and `npm run test:scenarios` (offline, deterministic).
- Behaviour regressions against real Gemini: `npx tsx --env-file-if-exists=.env scripts/e2e.ts --live --dir test/live`. Add a `test/live/*.chat` for every bug found in a real chat. It spends free-tier quota (about 15 requests a minute per model), so run it on its own, never alongside other live tests.
- Simulated group chats for exploratory or agent-driven testing: `scripts/persona-server.ts` (fake numbers, throwaway database, HTTP API). Start several servers one after another, not at once.
- Migrations are plain SQL in `src/db/migrations/`, applied in filename order on start.

## Environment

This project reads secrets from `.env` (gitignored). **Do not read, write, or echo `.env`** — it contains credentials.

If startup fails with an authentication error, tell the user to verify their `PROJECT_ID` / `PROJECT_SECRET` at the [Photon dashboard](https://app.photon.codes).

## Spectrum SDK reference

This project includes the `spectrum` skill from [`photon-hq/skills`](https://github.com/photon-hq/skills). Your agent should auto-discover it. If it doesn't, or if you switch agents, install for your agent with:

```sh
npx skills add photon-hq/skills --skill spectrum --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

## Managing the Spectrum Cloud project (CLI)

If this app uses a platform provider, the `PROJECT_ID` / `PROJECT_SECRET` in `.env` belong to a **Spectrum Cloud** project. To manage that project from the terminal — authenticate, rotate the secret, list the line(s) you send from, manage platforms/users, or create more projects — use the `photon-cli` skill (the `photon` CLI) from [`photon-hq/skills`](https://github.com/photon-hq/skills):

```sh
npx skills add photon-hq/skills --skill photon-cli --agent <your-agent>
```

(Use `--agent '*'` to install for all supported agents.)

Common tasks once it's installed:

- `photon whoami` — confirm you're authenticated (run `photon login` if not).
- `photon projects regenerate-secret` — rotate the Spectrum API secret (then update `PROJECT_SECRET` in `.env`).
- `photon spectrum lines list` — see the line(s) your app sends from.
- `photon projects show` — inspect the active project (set `PHOTON_PROJECT_ID`, or pass `--project <id>`).

## See also

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- [`spectrum-ts` on GitHub](https://github.com/photon-hq/spectrum-ts)
