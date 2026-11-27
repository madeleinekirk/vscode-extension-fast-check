"""Installs and builds each TypeScript repo and saves the runnable ones to RUNNABLE.md."""

import argparse
import csv
import json
import os
import shutil
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# copies go here because some build tools break on paths with spaces
WORK_DIR = os.path.expanduser("~/vscode-ext-work/repos")
TSC = os.path.abspath("node_modules/.bin/tsc")


def run(cmd, cwd, log, timeout, env):
    with open(log, "a") as f:
        f.write("\n$ " + cmd + "\n")
        f.flush()
        try:
            return subprocess.run(cmd, shell=True, cwd=cwd, stdout=f, stderr=f, env=env, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            f.write("TIMEOUT\n")
            return 1


def get_tool(repo):
    # use whatever package manager the repo's lockfile is for
    # (yarn and pnpm go through npx so they don't have to be installed)
    if os.path.exists(repo + "/yarn.lock"):
        return "npx --yes yarn@1"
    if os.path.exists(repo + "/pnpm-lock.yaml"):
        return "npx --yes pnpm@9"
    return "npm"


def install(repo, log, env):
    tool = get_tool(repo)
    if tool == "npm":
        cmd = "npm install --ignore-scripts --legacy-peer-deps"
    elif os.path.exists(repo + "/.yarnrc.yml"):
        cmd = tool + " install"  # yarn 2+ doesn't have --ignore-scripts, the env var turns them off
    else:
        cmd = tool + " install --ignore-scripts"
    if run(cmd, repo, log, 900, env) == 0:
        return True
    # try plain npm if the repo's own tool didn't work
    shutil.rmtree(repo + "/node_modules", ignore_errors=True)
    return run("npm install --ignore-scripts --legacy-peer-deps", repo, log, 900, env) == 0


def fix_old_vscode_package(repo, pkg):
    # the old "vscode" npm package gets vscode.d.ts from a microsoft site that's gone now,
    # so download it from github instead (version from engines.vscode, ex: ^1.18.0 -> 1.18.0)
    version = pkg.get("engines", {}).get("vscode", "").lstrip("^~>=")
    parts = version.split(".")
    if len(parts) < 2:
        return False
    if len(parts) == 2:
        version = version + ".0"
    url = "https://raw.githubusercontent.com/microsoft/vscode/" + version + "/src/vs/vscode.d.ts"
    try:
        text = urllib.request.urlopen(url, timeout=60).read().decode()
    except Exception:
        return False
    with open(repo + "/node_modules/vscode/vscode.d.ts", "w") as f:
        f.write(text)
    return True


def get_build_cmd(repo, scripts):
    tool = get_tool(repo)
    for name in ["compile", "build", "vscode:prepublish"]:
        # skip watch scripts, they never stop
        if name in scripts and "watch" not in scripts[name]:
            return tool + " run " + name
    if os.path.exists(repo + "/tsconfig.json"):
        if os.path.exists(repo + "/node_modules/.bin/tsc"):
            return "node_modules/.bin/tsc --noEmit -p ."
        return '"' + TSC + '" --noEmit -p .'
    return None


def first_error(log):
    with open(log, errors="replace") as f:
        for line in f:
            low = line.lower()
            if ("error" in low or "failed" in low or "timeout" in low) and not line.startswith("$"):
                return line.strip()[:300]
    return ""


def try_repo(name, dataset, env):
    src = os.path.join(dataset, name)
    repo = os.path.join(WORK_DIR, name)
    log_dir = os.path.join("logs", "task2", name)
    os.makedirs(log_dir, exist_ok=True)
    install_log = log_dir + "/install.log"
    build_log = log_dir + "/build.log"
    result = {"repo": name, "build_command": "", "runnable": "N", "error": ""}

    try:
        with open(src + "/package.json") as f:
            pkg = json.load(f)
    except (OSError, ValueError):
        result["error"] = "no package.json"
        return result

    shutil.rmtree(repo, ignore_errors=True)
    shutil.copytree(src, repo, symlinks=True)

    if not install(repo, install_log, env):
        result["error"] = first_error(install_log)
        return result

    scripts = pkg.get("scripts", {})
    postinstall = scripts.get("postinstall", "")
    if os.path.exists(repo + "/node_modules/vscode/bin/install"):
        if fix_old_vscode_package(repo, pkg) and "vscode/bin/install" in postinstall:
            postinstall = ""  # already done above
    if postinstall:
        if run(get_tool(repo) + " run postinstall", repo, install_log, 900, env) != 0:
            result["error"] = first_error(install_log)
            return result

    cmd = get_build_cmd(repo, scripts)
    if cmd is None:
        result["error"] = "no build script or tsconfig.json"
        return result
    result["build_command"] = cmd

    code = run(cmd, repo, build_log, 600, env)
    with open(build_log, errors="replace") as f:
        openssl_error = "ERR_OSSL" in f.read()
    if code != 0 and openssl_error:
        # old webpack versions need this on newer node
        env2 = dict(env)
        env2["NODE_OPTIONS"] = "--openssl-legacy-provider"
        code = run(cmd, repo, build_log, 600, env2)
        result["build_command"] = "NODE_OPTIONS=--openssl-legacy-provider " + cmd

    if code == 0:
        result["runnable"] = "Y"
    else:
        result["error"] = first_error(build_log)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()

    with open("results/task2_ts_repos.txt") as f:
        names = [line.strip() for line in f if line.strip()]

    env = dict(os.environ)
    env["YARN_ENABLE_SCRIPTS"] = "false"

    with ThreadPoolExecutor(args.jobs) as pool:
        results = list(pool.map(lambda name: try_repo(name, args.dataset, env), names))

    with open("results/task2_build_results.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["repo", "build_command", "runnable", "error"])
        writer.writeheader()
        writer.writerows(results)

    runnable = [r["repo"] for r in results if r["runnable"] == "Y"]
    with open("results/task2_runnable_repos.txt", "w") as f:
        f.write("\n".join(runnable) + "\n")

    with open("RUNNABLE.md", "w") as f:
        f.write("# Runnable repositories\n\n")
        f.write(f"{len(runnable)} of {len(names)} TypeScript repositories installed and built successfully.\n\n")
        for i, name in enumerate(runnable, 1):
            f.write(f"{i}. {name}\n")

    print(f"{len(runnable)} of {len(names)} repos are runnable")


if __name__ == "__main__":
    main()
