# Windows sandbox helper

The unsigned x64 CLI helper creates suspended processes in an LPAC with an
empty capability set, verifies the package SID and diagnostic DACL rights, and
resumes only after verifying job membership. The job kills the process tree
when the helper exits. Only standard input, output and error are inherited.
The LPAC check uses `AccessCheck` to distinguish ordinary application packages
from restricted packages. `TokenIsLessPrivilegedAppContainer` returned
`ERROR_INVALID_PARAMETER` on the hosted Windows image.

From an x64 Native Tools Command Prompt for Visual Studio, run the following
from a fresh disposable directory on NTFS.

```cmd
cl /nologo /std:c++17 /W4 /O2 /MT /Fe:acl-preflight.exe "<checkout>\native\windows-sandbox-helper\acl-preflight.cpp"
acl-preflight.exe --benchmark
cl /nologo /std:c++20 /W4 /O2 /MT /Fe:atomic-sandbox-helper.exe "<checkout>\native\windows-sandbox-helper\atomic-sandbox-helper.cpp"
node "<checkout>\native\windows-sandbox-helper\windows-integration.mjs" "%CD%\atomic-sandbox-helper.exe"
```

The preflight adds inheritable allow entries only for a new test profile on
the disposable fixture and binary. It compares host and LPAC access, checks
existing and newly created workspace files, verifies removal of inherited and
explicit entries, and measures a grant over 50,000 synthetic files. The
integration fixture uses the built helper and portable copies of Node and
the Git for Windows binaries. It needs a working LAN adapter, loopback and
external TCP to establish the unsandboxed reference results.

The workflow publishes the helper binary and records its size. It records the
benchmark timing separately. See the [user guide](../../docs/user/os-sandbox.md)
for operator consent, configuration and revocation.
