# Windows sandbox research

**Non in uso, solo valutazione.** These prototypes reproduce the Windows
sandbox assessment. The CLI and Desktop use their existing behavior. On
native Windows, Safe Mode refuses commands when requested. Use the CLI or
TUI inside WSL2 for a protected environment. [Assessment](../../docs/user/windows-sandbox-assessment.md)

## Observed results on windows-latest

| Candidate | Files | TCP | `NUL` and Git for Windows |
| --- | --- | --- | --- |
| LPAC with `registryRead` and ancestor metadata ACEs | Protected fixture reads and out-of-project writes were denied. Existing project files became accessible with recursive grants. | Explicit denial on external, LAN and loopback endpoints. | Win32 access denied for a read/write open. Stock Git stopped in `sanitize_stdfds()`. |
| Ordinary AppContainer with zero capabilities | Protected fixtures were denied. The audit found three profile cache files with packaged-app read ACEs and zero candidates in synthetic state. | External access was explicitly denied. LAN and loopback timed out after the unconfined reference connections succeeded. | Win32 access denied for a read/write open. Stock Git stopped during startup. |
| Restricted token with Everyone, Users and a dedicated SID | Shared files outside the project could be opened for reading and writing even at Low integrity. The owner-only control remained inaccessible. | The token provides no network isolation. | The Win32 read/write open succeeded. Git and npm were outside this preflight. |

- Recursive NTFS grant and revocation worked on a checkout with existing
  files. One run measured **5.3 seconds on 50,107 entries** with zero skips
  and zero errors. A root-only grant left existing files inaccessible.
- Stock Node in LPAC with zero capabilities failed during Winsock startup
  with `WSAStartup` error 10107. `registryRead` alone restored Node and
  Winsock while direct TCP and protected file access remained denied.
- One non-inheriting `FILE_READ_ATTRIBUTES | SYNCHRONIZE` allow ACE per
  ancestor, up to the volume root, restored `npm --version` and
  `npm ci --offline`. Volume listing and reads of a file in an ancestor
  remained denied. Revocation removed every ancestor ACE. The npm
  lifecycle shell still failed to resolve `node` by name.
- Git calls `sanitize_stdfds()` before loading configuration and
  unconditionally opens `/dev/null` read/write. Git for Windows maps that
  path to `NUL`. Disabling optional Git features and providing a readable
  empty config failed to change the result. [Git startup](https://github.com/git-for-windows/git/blob/main/common-init.c) · [Descriptor setup](https://github.com/git-for-windows/git/blob/main/setup.c)
- The restricted-token probe creates low-integrity shared fixtures with
  Everyone or Users read/write allow entries. Both Windows access checks
  succeeded outside the project even with Administrators disabled and the
  privileges other than `SeChangeNotifyPrivilege` removed.

## Reproduction

Use a disposable Windows x64 VM with NTFS, Visual Studio Build Tools and the
Windows SDK. Install stock Node 25.9.0 with npm, Git for Windows and PowerShell
7. Use a disposable NTFS volume for the targeted ACL experiment. It temporarily
adds an ACE up to that volume root. Use separate empty fixture directories
for the standalone probes. The TCP references need a LAN adapter, loopback
and external IPv4 access. The npm fixture prepares its cache before launching
npm offline.

Open an x64 Native Tools Command Prompt. Set `PROBES` to the absolute path of
this directory in the checkout and build from a disposable working directory.

```cmd
cl /nologo /std:c++17 /W4 /O2 /MT /Fe:acl-preflight.exe "%PROBES%\acl-preflight.cpp"
cl /nologo /std:c++17 /W4 /O2 /MT /Fe:restricted-token-preflight.exe "%PROBES%\restricted-token-preflight.cpp"
cl /nologo /std:c++20 /W4 /O2 /MT /DATOMIC_SANDBOX_DIAGNOSTICS /Fe:atomic-sandbox-diagnostic.exe "%PROBES%\atomic-sandbox-helper.cpp"
```

| Probe | Command |
| --- | --- |
| Recursive ACLs, inheritance, revocation and 50,000-file benchmark | Run the absolute path to `acl-preflight.exe --benchmark` from an empty NTFS directory. |
| Zero-capability LPAC and stock Node | Check that ordinary `node -e "console.log(1)"` prints `1`. From a fresh empty NTFS directory run `acl-preflight.exe --node "<absolute path to node.exe>"`. Expected failure includes Winsock 10107, Node exit `2147483651` and successful ACL controls. |
| Ordered LPAC capability matrix and AppContainer fallback | `node "%PROBES%\windows-integration.mjs" "%CD%\atomic-sandbox-diagnostic.exe" --matrix`. The raw matrix reports each candidate and fails when none satisfies the original acceptance criteria. |
| LPAC `registryRead`, Git environment and ancestor ACLs | `node "%PROBES%\windows-integration.mjs" "%CD%\atomic-sandbox-diagnostic.exe" --targeted --expect-observed`. |
| Ordinary AppContainer and packaged-app read ACL inventory | `node "%PROBES%\windows-integration.mjs" "%CD%\atomic-sandbox-diagnostic.exe" --appcontainer --expect-observed`. The script calls `audit-app-packages.ps1` in read-only mode. |
| Standalone profile and state ACL inventory | `pwsh -NoProfile -File "%PROBES%\audit-app-packages.ps1" -State "<absolute path to synthetic state>"`. |
| Restricted token at original and Low integrity | `restricted-token-preflight.exe "<existing empty fixture directory>" --expect-observed`. |
| Original launcher acceptance experiment | Run `windows-integration.mjs` with the diagnostic executable path and no mode flag. It stops at the first unmet acceptance condition. |

The [manual GitHub workflow](../../.github/workflows/sandbox-windows.yml)
checks the positive controls and the specific observed blockers. Success
means the recorded results reproduced. The ordinary PR runs exclude the
research workflow.
