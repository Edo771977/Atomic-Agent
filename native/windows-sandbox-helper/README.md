# Windows LPAC feasibility test

`acl-preflight.cpp` tests whether a non-propagating NTFS grant gives an LPAC
process access to an existing workspace. The Windows sandbox workflow builds it
with MSVC x64 and the static CRT. The diagnostic exits successfully only if it
can read both the existing file and the file created after the grant, and create
a new file under the fixture root.

To reproduce locally, use an x64 Native Tools Command Prompt for Visual Studio
and change to an empty, disposable directory on NTFS. Build a disposable copy
of the executable and run it from that directory.

```cmd
cl /nologo /std:c++17 /W4 /O2 /MT /Fe:acl-preflight.exe "<checkout>\native\windows-sandbox-helper\acl-preflight.cpp"
acl-preflight.exe
```

The test changes the ACL on its own executable and on its synthetic fixture.
Delete the disposable directory after the test. On the GitHub-hosted runner,
the ordinary process could read the existing file. The LPAC process could read
the later file and create a new file, but opening the existing file returned
Win32 error 5 (`ERROR_ACCESS_DENIED`). The Win32 LPAC token query returned error
87 (`ERROR_INVALID_PARAMETER`). An independent `AccessCheck` on a diagnostic
DACL distinguished the LPAC token from an ordinary AppContainer token and
allowed the file test to proceed.

The CLI continues to refuse Windows commands when the OS sandbox is requested.
