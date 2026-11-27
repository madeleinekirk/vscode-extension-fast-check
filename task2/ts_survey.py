"""Counts the TypeScript files in each repo and saves the repos with at least 5%."""

import argparse
import csv
import os

SKIP_DIRS = {"node_modules", ".git", "out", "dist", "build", ".vscode-test", "coverage"}
TS_EXT = (".ts", ".tsx", ".mts", ".cts")


def count_files(repo):
    total = ts = 0
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        total += len(files)
        ts += sum(f.endswith(TS_EXT) for f in files)
    return total, ts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--threshold", type=float, default=5)
    args = parser.parse_args()

    rows, ts_repos = [], []
    for name in sorted(os.listdir(args.dataset)):
        path = os.path.join(args.dataset, name)
        if not os.path.isdir(path) or name.startswith("."):
            continue
        total, ts = count_files(path)
        percent = round(100 * ts / total, 2) if total else 0
        rows.append([name, total, ts, percent])
        if percent >= args.threshold:
            ts_repos.append(name)

    os.makedirs("results", exist_ok=True)
    with open("results/task2_ts_survey.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["repo", "total_files", "ts_files", "ts_percent"])
        writer.writerows(rows)
    with open("results/task2_ts_repos.txt", "w") as f:
        f.write("\n".join(ts_repos) + "\n")

    print(f"{len(rows)} repos, {len(ts_repos)} have at least {args.threshold}% TypeScript files")


if __name__ == "__main__":
    main()
