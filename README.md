# vscode-extension-fast-check

Research project for COMP 6970. Testing TypeScript VS Code extensions with fast-check.

Folders:
- task2: finding the TypeScript repos and which ones run
- task3: testing one function per TypeScript file with fast-check
- task4: looking for race conditions with fc.scheduler()
- common: loader used by task 3 and 4 to run TypeScript files outside of VS Code
- results: output CSV files

## Setup

You need Python 3.9+ and Node 18+. The Python scripts only use the standard library.
Run `npm install` in this folder to get fast-check and TypeScript.

The dataset (yzz0229-VSCODE-DATA) isn't in this repo, so the scripts take its path with --dataset.
Run everything from this folder.

## Task 2

```
python3 task2/ts_survey.py --dataset ../yzz0229-VSCODE-DATA
python3 task2/build_repos.py --dataset ../yzz0229-VSCODE-DATA --jobs 4
```

ts_survey.py counts the files in each repo and keeps the ones where at least 5% are TypeScript
(.ts, .tsx, .mts, .cts). It doesn't count node_modules, .git or build folders.

build_repos.py copies each of those repos to ~/vscode-ext-work/repos, installs the dependencies
and runs the build (the compile, build or vscode:prepublish script, or tsc --noEmit if there isn't one).
If both work the repo counts as runnable. This takes a few hours.

Out of 430 repos, 299 have at least 5% TypeScript files and 199 of those are runnable.
The list is in RUNNABLE.md and the details are in results/task2_build_results.csv.

## Task 3 and 4

See task3/README.md and task4/README.md.
