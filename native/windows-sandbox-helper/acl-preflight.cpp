#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <cstdio>
#include <string>

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")

static void require(bool succeeded, const char* operation, DWORD error = GetLastError()) {
    if (!succeeded) {
        std::fprintf(stderr, "%s failed (%lu)\n", operation, error);
        ExitProcess(2);
    }
}

static DWORD checkFile(const wchar_t* name, DWORD disposition) {
    HANDLE file = CreateFileW(name, disposition == OPEN_EXISTING ? GENERIC_READ : GENERIC_WRITE,
        FILE_SHARE_READ, nullptr, disposition, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    CloseHandle(file);
    return ERROR_SUCCESS;
}

// Open without sharing for a non-propagating SetSecurityInfo update.
// This deliberately grants only the named object and inheritance for future children.
static void grant(const wchar_t* path, PSID sid, DWORD mask, DWORD inheritance) {
    HANDLE object = CreateFileW(path, READ_CONTROL | WRITE_DAC, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    require(object != INVALID_HANDLE_VALUE, "open ACL target");
    PACL original = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD error = GetSecurityInfo(object, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &original, nullptr, &descriptor);
    require(error == ERROR_SUCCESS, "read ACL", error);
    EXPLICIT_ACCESSW entry{};
    entry.grfAccessPermissions = mask;
    entry.grfAccessMode = GRANT_ACCESS;
    entry.grfInheritance = inheritance;
    BuildTrusteeWithSidW(&entry.Trustee, sid);
    PACL updated = nullptr;
    error = SetEntriesInAclW(1, &entry, original, &updated);
    require(error == ERROR_SUCCESS, "construct ACL", error);
    SECURITY_DESCRIPTOR replacement{};
    require(InitializeSecurityDescriptor(&replacement, SECURITY_DESCRIPTOR_REVISION) != FALSE,
        "initialize security descriptor");
    require(SetSecurityDescriptorDacl(&replacement, TRUE, updated, FALSE) != FALSE, "set DACL");
    require(SetKernelObjectSecurity(object, DACL_SECURITY_INFORMATION, &replacement) != FALSE, "apply ACL");
    LocalFree(updated);
    LocalFree(descriptor);
    CloseHandle(object);
}

// Independent diagnostic: bit 1 is available to ordinary packages, bit 2
// to restricted packages. Resume only if exactly the LPAC bit is granted.
static bool hasLpacAccess(HANDLE token) {
    HANDLE impersonation = nullptr;
    require(DuplicateToken(token, SecurityImpersonation, &impersonation) != FALSE,
        "duplicate token for access check");
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"O:SYG:SYD:(A;;0x3;;;WD)(A;;0x1;;;S-1-15-2-1)(A;;0x2;;;S-1-15-2-2)",
        SDDL_REVISION_1, &descriptor, nullptr) != FALSE, "create diagnostic security descriptor");
    GENERIC_MAPPING mapping{};
    PRIVILEGE_SET privileges{};
    DWORD bytes = sizeof(privileges), granted = 0;
    BOOL allowed = FALSE;
    require(AccessCheck(descriptor, impersonation, MAXIMUM_ALLOWED, &mapping,
        &privileges, &bytes, &granted, &allowed) != FALSE, "evaluate diagnostic ACL");
    LocalFree(descriptor);
    CloseHandle(impersonation);
    std::printf("Diagnostic DACL granted mask=%lu\n", granted);
    return allowed && granted == 2;
}

int wmain(int argc, wchar_t** argv) {
    if (argc == 2 && std::wstring(argv[1]) == L"--child") {
        DWORD existing = checkFile(L"before", OPEN_EXISTING);
        DWORD inherited = checkFile(L"after", OPEN_EXISTING);
        DWORD created = checkFile(L"created-by-lpac", CREATE_NEW);
        std::printf("existing=%lu inherited=%lu created=%lu\n", existing, inherited, created);
        if (inherited != ERROR_SUCCESS) return 1000 + inherited;
        if (created != ERROR_SUCCESS) return 2000 + created;
        if (existing != ERROR_SUCCESS) return 3000 + existing;
        return 0;
    }

    wchar_t executable[MAX_PATH]{};
    DWORD length = GetModuleFileNameW(nullptr, executable, MAX_PATH);
    require(length > 0 && length < MAX_PATH, "resolve test executable");
    require(CreateDirectoryW(L"fixture", nullptr) != FALSE, "create fixture");
    require(checkFile(L"fixture\\before", CREATE_NEW) == ERROR_SUCCESS, "create existing file");
    require(checkFile(L"fixture\\before", OPEN_EXISTING) == ERROR_SUCCESS, "unconfined read");
    std::wstring profile = L"AtomicAgent.AclPreflight." + std::to_wstring(GetCurrentProcessId());
    PSID sid = nullptr;
    HRESULT result = CreateAppContainerProfile(profile.c_str(), profile.c_str(), L"ACL preflight",
        nullptr, 0, &sid);
    require(SUCCEEDED(result), "create AppContainer profile", static_cast<DWORD>(result));
    grant(executable, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, NO_INHERITANCE);
    grant(L"fixture", sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE,
        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
    require(checkFile(L"fixture\\after", CREATE_NEW) == ERROR_SUCCESS, "create post-grant file");

    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
    auto attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, size));
    require(attributes && InitializeProcThreadAttributeList(attributes, 2, 0, &size), "initialize attributes");
    SECURITY_CAPABILITIES security{sid, nullptr, 0, 0};
    DWORD optOut = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        &security, sizeof(security), nullptr, nullptr) != FALSE, "set security capabilities");
    require(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        &optOut, sizeof(optOut), nullptr, nullptr) != FALSE, "set LPAC opt-out");
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process{};
    std::wstring command = L"\"" + std::wstring(executable) + L"\" --child";
    require(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, nullptr, L"fixture", &startup.StartupInfo, &process) != FALSE,
        "launch LPAC probe");
    HANDLE token = nullptr;
    require(OpenProcessToken(process.hProcess, TOKEN_QUERY | TOKEN_DUPLICATE, &token) != FALSE, "open child token");
    DWORD appContainer = 0, lpac = 0, bytes = 0;
    BOOL queriedAppContainer = GetTokenInformation(token, TokenIsAppContainer, &appContainer,
        sizeof(appContainer), &bytes);
    DWORD appContainerError = queriedAppContainer ? ERROR_SUCCESS : GetLastError();
    BOOL queriedLpac = GetTokenInformation(token, TokenIsLessPrivilegedAppContainer,
        &lpac, sizeof(lpac), &bytes);
    DWORD lpacError = queriedLpac ? ERROR_SUCCESS : GetLastError();
    std::printf("AppContainer=%lu (query error=%lu), LPAC=%lu (query error=%lu)\n",
        appContainer, appContainerError, lpac, lpacError);
    alignas(TOKEN_GROUPS) BYTE capabilityBuffer[sizeof(TOKEN_GROUPS)]{};
    BOOL queriedCapabilities = GetTokenInformation(token, TokenCapabilities, capabilityBuffer,
        sizeof(capabilityBuffer), &bytes);
    const bool noCapabilities = queriedCapabilities &&
        reinterpret_cast<const TOKEN_GROUPS*>(capabilityBuffer)->GroupCount == 0;
    const bool accessCheckVerified = hasLpacAccess(token);
    CloseHandle(token);
    if (!queriedAppContainer || appContainer != 1 || !noCapabilities || !accessCheckVerified ||
        (queriedLpac && lpac != 1)) {
        TerminateProcess(process.hProcess, 2);
        return 2;
    }
    require(ResumeThread(process.hThread) == 1, "resume verified LPAC probe");
    DWORD status = 2;
    if (WaitForSingleObject(process.hProcess, 10000) == WAIT_OBJECT_0) {
        require(GetExitCodeProcess(process.hProcess, &status) != FALSE, "read probe exit status");
    } else {
        TerminateProcess(process.hProcess, status);
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    DeleteProcThreadAttributeList(attributes);
    HeapFree(GetProcessHeap(), 0, attributes);
    FreeSid(sid);
    DeleteAppContainerProfile(profile.c_str());
    std::printf("probe status=%lu (1000+error: inherited read, 2000+error: create, 3000+error: existing read)\n", status);
    return static_cast<int>(status);
}
