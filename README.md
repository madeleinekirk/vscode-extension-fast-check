# vscode-extension-fast-check

COMP 6970 research project: testing open-source TypeScript VS Code extensions with
[fast-check](https://fast-check.dev/).

| Folder | What it does |
|---|---|
| `task2/` | Finds the TypeScript repos and checks which ones run |
| `task3/` | Tests one function per TypeScript file with fast-check |
| `task4/` | Looks for race conditions with `fc.scheduler()` |
| `common/` | Code shared by Tasks 3 and 4 (loads a TypeScript file outside VS Code) |
| `results/` | Generated CSV files |

## Setup

- Python 3.9+ (standard library only, see `requirements.txt`)
- Node.js 18+
- `npm install` in this folder (installs fast-check and TypeScript)

The dataset (`yzz0229-VSCODE-DATA`) is not in this repo. Every script takes its path with `--dataset`.
Run all commands from the root of this repo.

## Task 2

```bash
python3 task2/ts_survey.py --dataset /path/to/yzz0229-VSCODE-DATA
python3 task2/build_repos.py --dataset /path/to/yzz0229-VSCODE-DATA --jobs 4
```

`ts_survey.py` counts the files in each repo and keeps the ones where at least 5% are TypeScript
(`.ts`, `.tsx`, `.mts`, `.cts`; `node_modules`, `.git` and build folders are not counted).

`build_repos.py` copies each of those repos to `~/vscode-ext-work/repos`, installs its dependencies
with the package manager its lockfile uses (install scripts turned off), and runs its build step
(`compile`, `build` or `vscode:prepublish` script, otherwise `tsc --noEmit`). A repo is **runnable**
if both steps exit with code 0. It takes a few hours.

Results: 430 repos, 299 with at least 5% TypeScript files, **199 runnable** (see [RUNNABLE.md](RUNNABLE.md)
and `results/task2_build_results.csv`).

## Task 3

See [task3/README.md](task3/README.md).

## Task 4

See [task4/README.md](task4/README.md).
