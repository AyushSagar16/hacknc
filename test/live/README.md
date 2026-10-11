# Live behavior regressions

Each `.chat` here replays a bug found in a real group chat or a persona QA run, against real
Gemini (wording varies, so checks are regexes, SQL and silence). Run them all:

    npx tsx --env-file-if-exists=.env scripts/e2e.ts --live --dir test/live

or one: `... --dir test/live 03-tie`. They spend free-tier Gemini quota (~10–30 calls each).
