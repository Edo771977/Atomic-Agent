import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findShellSkillWrites } from "./state-secrets.js";

describe.skipIf(process.platform === "win32")("skill write destinations", () => {
  it.each([
    "install input /scratch/shared/out",
    "install -Dm644 input /scratch/shared/nested/out",
    "install -m 644 -t/scratch/shared input",
    "install --target-directory=/scratch/shared input",
    "rsync -a /elsewhere/shared /scratch",
    "ditto /elsewhere/shared /scratch",
    "bsdtar -xf archive -C /scratch/shared",
    "cd /scratch/shared && bsdtar -xf archive",
    "7z x archive -o/scratch/shared",
    "cd /scratch/shared && 7z e archive",
    "cpio -id -D /scratch/shared < archive",
    "cd /scratch/shared && cpio --extract < archive",
    "patch -d /scratch/shared -i patchfile",
    "patch --output=/scratch/shared/out -i patchfile",
    "cd /scratch/shared && patch < patchfile",
    "git -C /scratch/shared pull",
    "git -C /scratch -C shared checkout demo",
    "git -C /scratch/shared apply patchfile",
    "cd /scratch/shared && git reset HEAD",
    "cd /scratch/shared && git merge demo",
    "cd /scratch/shared && git am patchfile",
    "npm install --prefix /scratch/shared example",
    "npm --prefix=/scratch/shared install",
    "env -u SAMPLE -C /scratch/shared touch fixture",
    "env -S 'touch /scratch/shared/fixture'",
    "sudo -u sample -g sample nice -n 2 touch /scratch/shared/fixture",
    "timeout -k 1s 5s stdbuf -o L touch /scratch/shared/fixture",
    "xargs -n 1 touch /scratch/shared/fixture",
    "busybox touch /scratch/shared/fixture",
    "setsid -f touch /scratch/shared/fixture",
    "find /scratch/shared -type f -exec touch {} +",
    "printf '%s\\n' 'touch /scratch/shared/fixture' | sh",
    "sh <<< 'touch /scratch/shared/fixture'",
    "sh -s <<'SCRIPT'\ntouch /scratch/shared/fixture\nSCRIPT",
    "cd /scratch && sh -s <<SCRIPT\ntouch shared/fixture\nSCRIPT",
    "printf '%s\\n' /scratch/shared/fixture | xargs touch",
    "DEST=/scratch/shared; cd \"$DEST\" && git merge demo",
    "DEST=/scratch/shared; git -C \"$DEST\" pull",
    "DEST=/scratch; cp -r /elsewhere/shared \"$DEST\"",
    "SRC=/elsewhere/shared; cp -r \"$SRC\" /scratch",
    "DEST=\"$HOME/shared\"; cp input \"$DEST\"",
    "export DEST=/scratch/shared; cp input \"$DEST\"",
    "cp input \"$(printf '%s' /scratch/shared/fixture)\"",
    "cpio --pass-through /scratch/shared < file-list",
    "install -d /scratch/shared/demo",
  ])("extracts extended defensive write destinations for %s", (cmd) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(["/scratch/shared/"]);
  });

  it.each([
    "install -m 644 /scratch/shared/input /tmp/output",
    "rsync -a --dry-run /elsewhere/shared /scratch",
    "cd /scratch/shared && bsdtar -tf archive",
    "cd /scratch/shared && 7z l archive",
    "cd /scratch/shared && cpio -it < archive",
    "cd /scratch/shared && patch --dry-run < fixture",
    "git -C /scratch/shared log",
    "npm --prefix=/scratch/shared list",
    "find /scratch/shared -exec cat {} +",
    "printf '%s\\n' 'cat /scratch/shared/fixture' | sh",
    "sh <<< 'cat /scratch/shared/fixture'",
    "bash < /scratch/shared/script.sh",
    "sh -s <<'SCRIPT'\ncat /scratch/shared/fixture\nSCRIPT",
    "cat <<'TEXT'\ntouch /scratch/shared/fixture\nTEXT",
    "printf '%s\\n' /scratch/shared/fixture | xargs cat",
    "git -C /scratch/shared apply --check patchfile",
  ])("keeps read-only extended forms clear for %s", (cmd) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual([]);
  });

  it.each([
    ["touch /scratch/shared/file; echo ${NAME:-plain}", true],
    ["echo ${NAME:-plain}; touch /scratch/shared/file", true],
    ["echo $((1 + 2)); touch /scratch/shared/file", true],
    ["cat <(printf text); touch /scratch/shared/file", true],
    ["echo ${NAME:-plain} \"$((1 + 2))\"; cat <(printf text)", false],
    ["touch /scratch/shared/file; echo ${UNBALANCED", true],
    ["echo /scratch/shared/file; echo ${UNBALANCED", false],
    ["touch \"${DEST:-/scratch/shared/file}\"", true],
    ["echo \"${DEST:-/scratch/shared/file}\"", false],
  ] as const)("round five point 1 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["cd /scratch/shared; touch \"$NAME\"", true],
    ["cd /scratch/shared; touch *.md", true],
    ["for target in /scratch/shared/file /tmp/file; do touch \"$target\"; done", true],
    ["for target in /tmp/file /var/tmp/file; do touch \"$target\"; done", false],
  ] as const)("round five point 2 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["touch /scratch/shar{ed,ing}/file", true],
    ["touch /scratch/shar*/file", true],
    ["touch /scratch/shar[ei]d/file", true],
    ["touch /scratch/shar?x/file", false],
    ["mv /scratc? /tmp/backup", true],
  ] as const)("round five point 3 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["cp -r /source/. /scratch", true],
    ["rsync -a /source/ /scratch", true],
    ["ditto /source /scratch", true],
    ["cp -r /source /scratch", true],
    ["mv /source /scratch", true],
    ["ln -s /source /scratch", true],
    ["cp /scratch/shared/manifest /tmp/file", false],
  ] as const)("round five point 4 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["git -C /scratch/shared rebase main", true],
    ["git -C /scratch/shared stash pop", true],
    ["git -C /scratch/shared stash apply", true],
    ["git -C /scratch/shared switch main", true],
    ["git -C /scratch/shared cherry-pick HEAD", true],
    ["git -C /scratch/shared revert HEAD", true],
    ["git -C /scratch/shared restore file", true],
    ["git -C /scratch/shared clean -fd", true],
    ["git -C /scratch/shared rm file", true],
    ["git -C /scratch/shared mv file new", true],
    ["git -C /scratch/shared read-tree -u HEAD", true],
    ["git -C /scratch/shared checkout-index -a", true],
    ["git worktree add /scratch/shared/new", true],
    ["git -C /scratch/shared submodule update --init", true],
    ["git -C /scratch/shared clean -nd", false],
    ["git -C /scratch/shared stash list", false],
    ["git -C /scratch/shared worktree list", false],
  ] as const)("round five point 5 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["cd /scratch; npm install", false],
    ["cd /scratch; npm ci", false],
    ["git -C /scratch --work-tree=/tmp/work checkout main", false],
    ["find /scratch -name '*.log' -delete", false],
    ["find /scratch -maxdepth 1 -type f -exec touch {} +", false],
    ["patch -d /scratch ordinary.txt changes.diff", false],
    ["tar -xf archive -C /tmp/unpack", false],
  ] as const)("round five point 6 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });
  it("keeps protected find destinations when the starting directory is a symlink", () => {
    const home = mkdtempSync(join(tmpdir(), "skill-find-alias-"));
    try {
      const skills = join(home, "skills");
      const alias = join(home, "alias");
      mkdirSync(skills);
      writeFileSync(join(skills, "SKILL.md"), "synthetic skill");
      symlinkSync(skills, alias);
      expect(findShellSkillWrites({ cmd: "find -H " + alias + " -type f -exec touch {} +" },
        { workingDir: home }, { stateDir: home, files: [], skillWritePaths: [skills + "/"] },
        { home, platform: "linux" })).toEqual([skills + "/"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    "git status --short",
    "git log --oneline -5",
    "git diff --stat",
    "git show HEAD",
    "git branch --list",
    "git remote -v",
    "git fetch origin",
    "git pull --ff-only",
    "git switch main",
    "git checkout -- README.md",
    "git restore README.md",
    "git restore .",
    "git -C ./project checkout -- .",
    "git clean -nd",
    "git stash list",
    "git worktree list",
    "git submodule status",
    "npm --version",
    "npm list --depth=0",
    "npm test",
    "npm run lint",
    "npm install",
    "npm ci",
    "npm install --prefix ./project",
    "find . -maxdepth 1 -type f -print",
    "find . -type f -name '*.ts' -print",
    "find . -type f -name '*.log' -delete",
    "find . -maxdepth 1 -type f -exec touch {} +",
    "find . -type f -exec cat {} +",
    "cp README.md /tmp/atomic-r5-readme",
    "cp -r src ./copy",
    "cp package.json ./package.backup",
    "mv notes.txt notes.old",
    "mv ./draft ./archive",
    "mv ./report.txt /tmp/atomic-r5-report.txt",
    "patch --dry-run -i changes.diff",
    "patch README.md changes.diff",
    "tar -tf archive.tar",
    "tar -xf archive.tar -C /tmp/atomic-r5-unpack",
    "unzip -l archive.zip",
  ])("keeps ordinary project and home commands clear: %s", (cmd) => {
    const home = mkdtempSync(join(tmpdir(), "skill-write-home-"));
    try {
      const project = join(home, "project");
      const skills = join(home, ".agents", "skills");
      mkdirSync(join(project, ".git"), { recursive: true });
      mkdirSync(skills, { recursive: true });
      writeFileSync(join(skills, "SKILL.md"), "synthetic skill");
      for (const workingDir of [project, home]) {
        expect(findShellSkillWrites({ cmd }, { workingDir }, {
          stateDir: join(home, ".atomic-agent"), files: [], skillWritePaths: [skills + "/"],
        }, { home, platform: "linux" }), workingDir).toEqual([]);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["find /scratch/shared -type f -print0 | xargs -0 touch", true],
    ["ls /scratch/shared | xargs touch", true],
    ["find /scratch/shared -type f -print0 | xargs -0 cat", false],
    ["ls /tmp | xargs touch", false],
    ["cd /scratch; ls . | xargs touch", true],
    ["cd /; ls . | xargs touch", false],
  ] as const)("round five point 7 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["printf '%s %s\\n' touch /scratch/shared/file | sh", true],
    ["printf '%s %s\\n' cat /scratch/shared/file | sh", false],
    ["printf '%s %s\\n' touch /tmp/file | sh", false],
    ["DEST=/scratch/shared/file; printf '%s %s\\n' touch \"$DEST\" | sh", true],
    ["DEST=/scratch/shared/file; printf '%s %s\\n' cat \"$DEST\" | sh", false],
  ] as const)("round five point 8 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["DEST=shared/file; cd /scratch; touch \"$DEST\"", true],
    ["DEST=shared/file; cd /tmp; touch \"$DEST\"", false],
  ] as const)("round five point 9 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["sudo -D /scratch/shared touch file", true],
    ["find /scratch/shared -ok touch {} \\;", true],
    ["find /scratch/shared -ok cat {} \\;", false],
    ["setsid touch /scratch/shared/file", true],
    ["gh repo clone example/repo /scratch/shared/new", true],
    ["glab repo clone example/repo /scratch/shared/new", true],
    ["gh repo view example/repo", false],
    ["find /scratch/shared -okdir touch {} \\;", true],
    ["find /tmp -exec sh -c 'touch /scratch/shared/file' \\;", true],
    ["sudo --chdir=/tmp touch file", false],
    ["nohup touch /scratch/shared/file", true],
  ] as const)("round five point 10 classifies %s", (cmd, blocked) => {
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: ["/scratch/shared/"],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? ["/scratch/shared/"] : []);
  });

  it.each([
    ["cat > README.md <<'EOF'\nExample: $(cp ./demo /scratch/.agents/skills/demo)\nEOF", false],
    ["git commit -F - <<'EOF'\nExample: `touch /scratch/.agents/skills/demo`\nEOF", false],
    ["gh pr create --body \"$(cat <<'EOF'\nExample: `touch /scratch/.agents/skills/demo`\nEOF\n)\"", false],
    ["cat > docs/skills.md <<'EOF'\nExample: $(mkdir /scratch/.agents/skills/demo)\nEOF", false],
    ["cat <<EOF\n${LABEL:-x} $(touch /scratch/.agents/skills/demo)\nEOF", true],
    ["cat <<EOF\n'$(touch /scratch/.agents/skills/demo)'\nEOF", true],
  ] as const)("round six point 2 classifies %s", (cmd, blocked) => {
    const protectedDir = "/scratch/.agents/skills/";
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: [protectedDir],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? [protectedDir] : []);
  });

  it.each([
    ["touch /scratch/.agents/skills/example\\", true],
    ["cp input /scratch/.agents/skills/example\\", true],
  ] as const)("round six point 3 classifies %s", (cmd, blocked) => {
    const protectedDir = "/scratch/.agents/skills/";
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: [protectedDir],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? [protectedDir] : []);
  });

  it.each([
    ["DEST='/scratch/.agents/sk?lls/demo'; echo x >> \"$DEST\"", true],
    ["for dest in /scratch/.agents/sk?lls/demo; do sed -i s/a/b/ \"$dest\"; done", true],
    ["DEST='/scratch/.agents/sk?lls/sub/'; cp input \"$DEST\"", true],
    ["DEST='../.agents/sk?lls/demo'; cd /scratch/project; echo x >> \"$DEST\"", true],
    ["cd /scratch; for dest in .agents/sk?lls/sub/; do cp input \"$dest\"; done", true],
  ] as const)("round six point 4 classifies %s", (cmd, blocked) => {
    const protectedDir = "/scratch/.agents/skills/";
    expect(findShellSkillWrites({ cmd }, { workingDir: "/work" }, {
      stateDir: "/settings", files: [], skillWritePaths: [protectedDir],
    }, { home: "/scratch", platform: "linux" })).toEqual(blocked ? [protectedDir] : []);
  });
});
