"""Runs fc_test.js on every TypeScript file in the runnable repos and writes the task 3 CSV."""

import argparse
import csv
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FC_TEST = os.path.join(ROOT, "task3", "fc_test.js")
WORK_DIR = os.path.expanduser("~/vscode-ext-work/repos")
SKIP_DIRS = {"node_modules", ".git", "out", "dist", "build", ".vscode-test", "coverage"}
COLUMNS = ["FilePath", "TestCaseName", "FunctionName", "Status", "ExpectedValue",
           "ProvidedValue", "ErrorMessage", "FailureCategory", "InputParamater"]
TIMEOUT = 60


def ts_files(repo_dir):
    found = []
    for root, dirs, files in os.walk(repo_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(files):
            if f.endswith((".ts", ".tsx")) and not f.endswith(".d.ts"):
                found.append(os.path.join(root, f))
    return found


def run_file(path, repo_dir, num_runs):
    lines = []
    try:
        p = subprocess.run(["node", FC_TEST, path, str(num_runs)], cwd=repo_dir,
                           capture_output=True, text=True, timeout=TIMEOUT)
        out = p.stdout
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
    for line in out.splitlines():
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            lines.append(obj)
    return lines


def make_rows(file_path, lines):
    info = next((l for l in lines if "function" in l), None)
    if info is None:
        return []
    result = next((l for l in lines if "status" in l), None)
    if result is None:
        # no result line means the whole file timed out or node crashed
        result = {"status": "Failed", "provided": "no result", "error": "test did not finish",
                  "category": "Hang", "inputs": []}
    failed = result["status"] == "Failed"
    name = info["function"]
    base = [file_path, "test_" + name.replace(".", "_"), name, result["status"], info["expected"],
            result.get("provided", ""), result.get("error", "") if failed else "",
            result.get("category", "") if failed else ""]
    params = info["params"]
    if not params:
        return [base + ["(none)"]]
    rows = []
    inputs = result.get("inputs") or []
    for i, p in enumerate(params):
        value = f"{p['name']}: {p['type']}"
        if failed and i < len(inputs):
            value += " = " + str(inputs[i])
        rows.append(base + [value])
    return rows


def test_repo(repo, args):
    built = os.path.join(WORK_DIR, repo)
    repo_dir = built if os.path.isdir(built) else os.path.join(args.dataset, repo)
    rows = []
    for path in ts_files(repo_dir):
        rel = os.path.relpath(path, repo_dir)
        file_path = os.path.join(os.path.basename(os.path.normpath(args.dataset)), repo, rel)
        rows += make_rows(file_path, run_file(path, repo_dir, args.num_runs))
    print(repo, len(rows), "rows", flush=True)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--num-runs", type=int, default=100)
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()

    with open(os.path.join(ROOT, "results", "task2_runnable_repos.txt")) as f:
        repos = [line.strip() for line in f if line.strip()]
    if args.only:
        repos = [r for r in repos if r in args.only]

    with ThreadPoolExecutor(args.jobs) as pool:
        results = list(pool.map(lambda r: test_repo(r, args), repos))

    out = os.path.join(ROOT, "results", "task3_results.csv")
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(COLUMNS)
        for rows in results:
            w.writerows(rows)
    print("wrote", sum(len(r) for r in results), "rows to", out)


if __name__ == "__main__":
    main()
