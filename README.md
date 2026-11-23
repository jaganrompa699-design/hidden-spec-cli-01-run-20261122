# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jaganrompa699-design/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jaganrompa699-design/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every format AI models write edits in: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. It finds each edit's lines at the first of three matching tiers (exact, trailing whitespace, indentation), applies every edit or none, and reports exactly what changed. Node 22, standard library only, deterministic.

## Run it

```sh
node main.ts [options] [PATCH]
```

## What it does

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` reads a patch from the file PATCH (or standard input when PATCH is absent or `-`) and applies it to the tree of text files in the working directory. `--format` picks one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it). `--check` reports what would change without writing anything. `--strict` matches lines exactly, at tier 0 only.

Each edit is applied in the patch's order to the tree as earlier edits left it. A failed edit changes nothing, the edits after it still run, and when any edit failed no file is written at all. On success it prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move) and a final `ok: N files` line. `SPEC.md` is the whole contract.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the trial runner the kit provides; `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts`: the practice set on your own machine — `node check.ts <practice.json>` runs `main.ts` on all 100 practice checks and prints the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

---

Entered on [make.fun](https://make.fun/?ref=hygxtk3b&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
