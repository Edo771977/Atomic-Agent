# Windows sandbox helper

The CLI keeps the backend disabled until stock Node and the network probes
pass under zero-capability LPAC. On `windows-latest`, ACL tests passed and
the grant on 50,107 objects took between about two and seven seconds in
the recorded runs. Stock Node printed `1` unconfined but exited with
`WSAStartup` error 10107 inside LPAC. The WinRT TCP diagnostic returned
`E_ACCESSDENIED` during COM initialization, before a socket was created.
The Windows jobs report compatibility and network checks as failures.

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
acl-preflight.exe --node "<absolute path to stock node.exe>"
cl /nologo /std:c++20 /W4 /O2 /MT /Fe:atomic-sandbox-helper.exe "<checkout>\native\windows-sandbox-helper\atomic-sandbox-helper.cpp"
node "<checkout>\native\windows-sandbox-helper\windows-integration.mjs" "%CD%\atomic-sandbox-helper.exe"
```

Use a separate disposable directory for each preflight invocation.

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
