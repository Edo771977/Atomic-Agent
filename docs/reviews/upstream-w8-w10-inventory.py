"""Read-only Git inventory for the November 25-27 upstream documentation triage.

Run from a fork checkout containing the pinned upstream objects. JSON goes to
stdout; no checkout, fetch, cherry-pick, package install or repository write.
--counts-only skips chain reconstruction; --imports adds trailers/git cherry.
"""
import argparse
import collections
import functools
import json
from pathlib import Path
import re
import subprocess

REPO = Path(__file__).resolve().parents[2]
START = "89d65615e36b763b35bc81c1e64304bd2d0e5c7c"
END = "e89b59033db3494c0ffa6a3bc1786ba17c4ba894"
FORK = "7511497b02504f81ffa03ec8f63367119fdaa6d8"
WAVES = {"w8": "e447427cc", "w9": "06de6ae39", "w10": "a0210e15f"}
W9 = {"ato-1689": 1756, "ato-1754": 1757, "ato-1700": 1759, "ato-1688": 1761}


@functools.lru_cache(maxsize=None)
def git(*args):
    return subprocess.check_output(
        ["git", "-C", str(REPO), *args], encoding="utf-8"
    ).strip()


def log(revision, *options):
    value = git("log", "--reverse", "--topo-order", "--format=%H%x09%P%x09%s", *options, revision)
    return [dict(zip(("sha", "parents", "subject"), line.split("\t", 2))) for line in value.splitlines()]


def counts(revision):
    return {label: len(log(revision, *options)) for label, options in (
        ("all", ()), ("non_merge", ("--no-merges",)), ("merge", ("--merges",))
    )}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--counts-only", action="store_true")
    parser.add_argument("--imports", action="store_true")
    args = parser.parse_args()
    rows = log(f"{START}..{END}")
    result = {"start": START, "end": END, "fork": FORK,
              "range_counts": counts(f"{START}..{END}"),
              "wave_counts": {name: counts(f"{ref}^1..{ref}") for name, ref in WAVES.items()}}
    prs = {}

    def add(number, wave, merge):
        first, head = merge["parents"].split()
        item = prs.setdefault(number, {"pr": number, "wave": wave, "merges": [], "commits": [], "integration_files": []})
        item["merges"].append(merge)
        if args.counts_only:
            return
        known = {commit["sha"] for commit in item["commits"]}
        item["commits"].extend(commit for commit in log(f"{first}..{head}") if commit["sha"] not in known)
        item["integration_files"] = sorted(set(item["integration_files"]) | set(git("diff", "--name-only", first, merge["sha"]).splitlines()))

    for wave, ref in WAVES.items():
        for merge in log(f"{ref}^1..{ref}^2", "--first-parent"):
            match = re.match(r"(?:Re-merge|Merge(?: PR)?) #(\d+)\b", merge["subject"])
            number = int(match[1]) if match else None
            if wave == "w9" and len(merge["parents"].split()) == 2:
                number = next((value for branch, value in W9.items() if branch in merge["subject"]), None)
            if number and len(merge["parents"].split()) == 2:
                add(number, wave, merge)
    for number, ref in ((1540, "01fb808bd"), (1766, "3c7dcb8e6")):
        add(number, "direct", log(f"{ref}^1..{ref}", "--first-parent")[0])
    result["functional_prs"] = len(prs)
    result["prs_by_wave"] = dict(collections.Counter(item["wave"] for item in prs.values()))
    result["including_containers"] = len(prs) + len(WAVES)
    if args.counts_only:
        print(json.dumps(result, indent=2))
        return

    sources = {commit["sha"] for item in prs.values() for commit in item["commits"] if len(commit["parents"].split()) == 1}
    raw = subprocess.check_output(
        ["git", "-C", str(REPO), "log", "--no-walk", "--stdin", "--name-only", "--format=COMMIT %H"],
        input="\n".join(sorted(sources)), encoding="utf-8"
    )
    files = {}
    for block in raw.split("COMMIT ")[1:]:
        lines = block.splitlines()
        files[lines[0]] = sorted(set(filter(None, lines[1:])))
    imports = collections.defaultdict(list)
    equivalent = {}
    if args.imports:
        messages = git("log", "--format=%H%n%B", FORK)
        for message in re.split(r"(?m)^(?=[a-f0-9]{40}$)", messages):
            if message:
                for sha in re.findall(r"cherry picked from commit ([a-f0-9]{40})", message):
                    imports[sha].append(message.splitlines()[0])
        equivalent = {line[2:42]: line[0] for line in git("cherry", FORK, END, START).splitlines()}
    for item in prs.values():
        item["chain_files"] = sorted({path for commit in item["commits"] for path in files.get(commit["sha"], [])})
        for commit in item["commits"]:
            if args.imports:
                commit["trailer_imports"] = imports[commit["sha"]]
                commit["cherry"] = equivalent.get(commit["sha"])
    covered = {commit["sha"] for item in prs.values() for commit in item["commits"]}
    covered |= {merge["sha"] for item in prs.values() for merge in item["merges"]}
    result["prs"] = sorted(prs.values(), key=lambda item: item["pr"])
    result["other_commits"] = [commit for commit in rows if commit["sha"] not in covered]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
