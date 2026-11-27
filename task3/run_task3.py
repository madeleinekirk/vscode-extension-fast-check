#!/usr/bin/env python3
"""Task 3 driver: run the fast-check harness on every runnable repository and write the CSV.

Usage:
    python3 task3/run_task3.py --dataset /path/to/yzz0229-VSCODE-DATA [--jobs 4]

For each repository listed in results/task2_runnable_repos.txt this script runs
`node task3/harness.js` on it. The harness tests one function per TypeScript file with
fast-check and writes one JSON line per file to logs/task3/<repo>.jsonl.

If the harness stops producing output for --file-timeout seconds (a synchronous infinite loop
in the code under test, which cannot be interrupted from inside Node), the process is killed,
the file is recorded as a hang, and the harness is restarted at the next file.

When every repository is done, the JSON lines are converted to:
    results/task3_fastcheck_results.csv   one row per tested function parameter (spec columns)
    results/task3_skipped_files.csv       TypeScript files with nothing to test, and why
    results/task3_summary.md              counts per status and failure category

The run can be stopped and restarted: repositories whose log ends with a "done" event are
skipped unless --force is given. --only repoA repoB limits the run to some repositories.
"""
import argparse
import collections
import concurrent.futures as cf
import csv
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / "task3" / "harness.js"
CSV_COLUMNS = ["FilePath", "TestCaseName", "FunctionName", "Status", "ExpectedValue",
               "ProvidedValue", "ErrorMessage", "FailureCategory", "InputParamater"]


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", required=True, help="folder containing the extension repositories")
    ap.add_argument("--repos-file", default=str(ROOT / "results" / "task2_runnable_repos.txt"),
                    help="list of repositories to test (default: Task 2 runnable list)")
    ap.add_argument("--work-dir", default=str(Path.home() / "vscode-ext-work" / "repos"),
                    help="built copies from Task 2; used instead of the dataset copy when present, "
                         "so installed dependencies are loaded instead of stubbed")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--num-runs", type=int, default=100, help="fast-check runs per function")
    ap.add_argument("--call-timeout", type=int, default=2000, help="ms an async call may take")
    ap.add_argument("--file-timeout", type=int, default=30, help="seconds without progress = hang")
    ap.add_argument("--logs", default=str(ROOT / "logs" / "task3"))
    ap.add_argument("--results", default=str(ROOT / "results"))
    ap.add_argument("--only", nargs="*", help="only these repositories")
    ap.add_argument("--force", action="store_true", help="re-run repositories that are already done")
    ap.add_argument("--csv-only", action="store_true", help="only rebuild the CSV files from the logs")
    return ap.parse_args()


def read_events(path):
    events = []
    if not path.exists():
        return events
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass  # a line cut off when the process was killed
    return events


def run_repo(repo, args):
    """Run the harness on one repository, restarting after hangs. Returns (repo, message)."""
    work = Path(args.work_dir) / repo
    repo_dir = work if (work / "package.json").exists() else Path(args.dataset) / repo
    if not repo_dir.is_dir():
        return repo, "missing"
    log = Path(args.logs) / f"{repo}.jsonl"
    if args.force and log.exists():
        log.unlink()
    events = read_events(log)
    if events and events[-1].get("event") == "done":
        return repo, "already done"

    start = 0
    if events:
        done_idx = [e["index"] for e in events if e.get("event") == "result"]
        start = (max(done_idx) + 1) if done_idx else 0
    restarts = 0
    while True:
        cmd = ["node", "--max-old-space-size=2048", str(HARNESS), "--repo-dir", str(repo_dir),
               "--repo-name", repo, "--out", str(log), "--num-runs", str(args.num_runs),
               "--call-timeout", str(args.call_timeout), "--start", str(start)]
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                cwd=str(repo_dir), start_new_session=True)
        last_size, last_change = -1, time.time()
        while proc.poll() is None:
            time.sleep(1)
            size = log.stat().st_size if log.exists() else 0
            if size != last_size:
                last_size, last_change = size, time.time()
            elif time.time() - last_change > args.file_timeout:
                os.killpg(proc.pid, 9)
                proc.wait()
                break
        events = read_events(log)
        if events and events[-1].get("event") == "done":
            return repo, f"done ({restarts} restarts)"
        # Find the file the harness was working on and record it.
        last = events[-1] if events else None
        if last is None:
            return repo, f"harness produced no output (exit {proc.returncode})"
        idx = last.get("index", start)
        if last.get("event") == "testing":
            hang = {"event": "result", "index": idx, "repo": repo, "file": last["file"], "skipped": False,
                    "testCase": "fc_" + last["functionName"].replace(".", "_") + "_no_runtime_error",
                    "functionName": last["functionName"], "line": last.get("line"),
                    "expected": last.get("expected", ""), "params": last.get("params", []),
                    "status": "Failed", "provided": "<no result: process did not return>",
                    "error": f"no progress for {args.file_timeout} s (synchronous infinite loop or blocking call)",
                    "category": "Hang (synchronous)", "counterexample": None}
        elif last.get("event") == "start":
            hang = {"event": "result", "index": idx, "repo": repo, "file": last["file"], "skipped": True,
                    "reason": "module hung or crashed the process while loading"}
        else:  # crashed between files
            idx = last.get("index", start)
            hang = None
        with open(log, "a", encoding="utf-8") as f:
            if hang:
                f.write(json.dumps(hang) + "\n")
        start = idx + 1
        restarts += 1
        if restarts > 200:
            with open(log, "a", encoding="utf-8") as f:
                f.write(json.dumps({"event": "done", "aborted": True}) + "\n")
            return repo, "aborted after 200 restarts"


def dataset_path(args, file_rel):
    return f"{Path(args.dataset).name}/{file_rel}"


def build_csv(args, repos):
    results = Path(args.results)
    results.mkdir(parents=True, exist_ok=True)
    rows, skipped = [], []
    status_count = collections.Counter()
    cat_count = collections.Counter()
    repos_with_fail = set()
    for repo in repos:
        seen = {}
        for e in read_events(Path(args.logs) / f"{repo}.jsonl"):
            if e.get("event") == "result":
                seen[e["file"]] = e  # last result per file wins
        for file_rel in sorted(seen):
            e = seen[file_rel]
            fp = dataset_path(args, file_rel)
            if e.get("skipped"):
                skipped.append([fp, e.get("reason", "")])
                continue
            status_count[e["status"]] += 1
            if e["status"] == "Failed":
                cat_count[e["category"]] += 1
                repos_with_fail.add(repo)
            params = e.get("params") or []
            cex = e.get("counterexample") or []
            base = [fp, e["testCase"], e["functionName"], e["status"], e.get("expected", ""),
                    e.get("provided", ""), e.get("error", "") if e["status"] == "Failed" else "",
                    e.get("category", "") if e["status"] == "Failed" else ""]
            if not params:
                rows.append(base + ["(no parameters)"])
            for i, p in enumerate(params):
                desc = f"{'...' if p.get('rest') else ''}{p['name']}{'?' if p.get('optional') else ''}: {p['type']}"
                if e["status"] == "Failed" and i < len(cex):
                    desc += f" = {cex[i]}"
                rows.append(base + [desc])

    with open(results / "task3_fastcheck_results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CSV_COLUMNS)
        w.writerows(rows)
    with open(results / "task3_skipped_files.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["FilePath", "Reason"])
        w.writerows(skipped)

    skip_reasons = collections.Counter(
        (r[1].split(":")[0].split(" (")[0]) for r in skipped)
    tested = sum(status_count.values())
    lines = [
        "# Task 3 summary", "",
        f"- Repositories: {len(repos)}",
        f"- TypeScript files: {tested + len(skipped)}",
        f"- Files with a tested function: {tested}",
        f"- Passed: {status_count['Passed']}",
        f"- Failed: {status_count['Failed']} (in {len(repos_with_fail)} repositories)",
        f"- Files with nothing to test: {len(skipped)}",
        f"- CSV rows (one per parameter): {len(rows)}", "",
        "## Failure categories", "", "| Category | Functions |", "|---|---|",
        *[f"| {k} | {v} |" for k, v in cat_count.most_common()], "",
        "## Why files were skipped", "", "| Reason | Files |", "|---|---|",
        *[f"| {k} | {v} |" for k, v in skip_reasons.most_common()], "",
    ]
    (results / "task3_summary.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:9]))


def main():
    args = parse_args()
    repos = [l.strip() for l in open(args.repos_file) if l.strip() and not l.startswith("#")]
    if args.only:
        repos = [r for r in repos if r in set(args.only)]
    Path(args.logs).mkdir(parents=True, exist_ok=True)
    if not args.csv_only:
        started = time.time()
        with cf.ThreadPoolExecutor(max_workers=args.jobs) as ex:
            futs = {ex.submit(run_repo, r, args): r for r in repos}
            for n, fut in enumerate(cf.as_completed(futs), 1):
                repo, msg = fut.result()
                print(f"[{n}/{len(repos)}] {repo}: {msg} ({time.time() - started:.0f}s)", flush=True)
    all_repos = [l.strip() for l in open(args.repos_file) if l.strip() and not l.startswith("#")]
    build_csv(args, all_repos)


if __name__ == "__main__":
    sys.exit(main())
