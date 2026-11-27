"""Run only in a disposable checkout of this PR after npm ci.

The candidate assertion failures are expected. This modifies candidate files.
It does not publish or wire production entry points.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
os.chdir(root)
commit = '4bee18579184f2a0a7bfe5e08d372c03eb6d2172'
leaves = ['src/mcp/mcp-client.ts', 'src/mcp/mcp-sandbox-paths.ts']
test = 'src/mcp/b6b-candidate.test.ts'
node = shutil.which("node")
if not node or not Path("node_modules/vitest/vitest.mjs").is_file():
    raise SystemExit("Run npm ci first with Node >=25.7")
if Path(test).exists() or any(Path(name).exists() for name in leaves if name.endswith(("hermes-plugins.ts", "mcp-sandbox-paths.ts"))):
    raise SystemExit("Use a fresh disposable checkout; candidate files already exist")
subprocess.run(["git", "cat-file", "-e", commit], check=True)
subprocess.run(["git", "apply", 'docs/reviews/b6b-candidate-tests.patch'], check=True)
env = dict(os.environ, B6_REVIEW_PYTHON=str(Path(sys.executable).resolve()))
def run(label):
    return subprocess.run([node, "node_modules/vitest/vitest.mjs", "run", test, "--reporter=json", "--outputFile=" + 'b6b' + "-review-" + label + ".json"], env=env).returncode
before = run("before")
print("before candidate exit:", before, flush=True)
for name in leaves:
    content = subprocess.check_output(["git", "show", commit + ":" + name])
    path = Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
after = run("candidate")
print("candidate exit (expected nonzero):", after, flush=True)
sys.exit(after)
