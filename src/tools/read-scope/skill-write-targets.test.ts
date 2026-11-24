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
});
