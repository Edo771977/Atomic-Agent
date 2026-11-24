#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <cstdio>
#include <string>
#include "acl-tree.h"

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")

static void require(bool succeeded, const char* operation, DWORD error = GetLastError()) {
    if (!succeeded) {
        std::fprintf(stderr, "%s failed (%lu)\n", operation, error);
        ExitProcess(2);
    }
}

static DWORD checkFile(const wchar_t* name, DWORD disposition, DWORD access = 0) {
    HANDLE file = CreateFileW(name, access ? access : (disposition == OPEN_EXISTING ? GENERIC_READ : GENERIC_WRITE),
        FILE_SHARE_READ, nullptr, disposition, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    CloseHandle(file);
    return ERROR_SUCCESS;
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
    if (argc == 3 && std::wstring(argv[1]) == L"--child") {
        DWORD existing = checkFile(L"deep\\nested\\before", OPEN_EXISTING);
        DWORD modified = checkFile(L"deep\\nested\\before", OPEN_EXISTING, GENERIC_WRITE);
        DWORD inherited = checkFile(L"after", OPEN_EXISTING);
        DWORD created = checkFile(L"created-by-lpac", CREATE_NEW);
        DWORD key = checkFile(L"..\\state\\serve-api.key", OPEN_EXISTING);
        DWORD outside = checkFile(L"..\\state\\outside", OPEN_EXISTING, GENERIC_WRITE);
        DWORD profileRead = checkFile(argv[2], OPEN_EXISTING);
        DWORD profileWrite = checkFile(argv[2], OPEN_EXISTING, GENERIC_WRITE);
        std::printf("existing=%lu modified=%lu inherited=%lu created=%lu key=%lu outside=%lu profileRead=%lu profileWrite=%lu\n",
            existing, modified, inherited, created, key, outside, profileRead, profileWrite);
        return existing == ERROR_SUCCESS && modified == ERROR_SUCCESS &&
            inherited == ERROR_SUCCESS && created == ERROR_SUCCESS &&
            key == ERROR_ACCESS_DENIED && outside == ERROR_ACCESS_DENIED &&
            profileRead == ERROR_ACCESS_DENIED && profileWrite == ERROR_ACCESS_DENIED ? 0 : 3;
    }

    wchar_t executable[MAX_PATH]{};
    DWORD length = GetModuleFileNameW(nullptr, executable, MAX_PATH);
    require(length > 0 && length < MAX_PATH, "resolve test executable");
    require(CreateDirectoryW(L"fixture", nullptr) != FALSE, "create fixture");
    require(CreateDirectoryW(L"fixture\\deep", nullptr) != FALSE, "create nested directory");
    require(CreateDirectoryW(L"fixture\\deep\\nested", nullptr) != FALSE, "create deep directory");
    require(CreateDirectoryW(L"state", nullptr) != FALSE, "create synthetic state");
    require(checkFile(L"fixture\\deep\\nested\\before", CREATE_NEW) == ERROR_SUCCESS, "create existing file");
    require(checkFile(L"state\\serve-api.key", CREATE_NEW) == ERROR_SUCCESS, "create synthetic key");
    require(checkFile(L"state\\outside", CREATE_NEW) == ERROR_SUCCESS, "create outside control");
    wchar_t userProfile[MAX_PATH]{};
    DWORD profileLength = GetEnvironmentVariableW(L"USERPROFILE", userProfile, MAX_PATH);
    require(profileLength > 0 && profileLength < MAX_PATH, "locate user profile");
    std::wstring profileFile = std::wstring(userProfile) + L"\\atomic-lpac-preflight-" +
        std::to_wstring(GetCurrentProcessId());
    require(checkFile(profileFile.c_str(), CREATE_NEW) == ERROR_SUCCESS, "create profile control");
    require(checkFile(L"fixture\\deep\\nested\\before", OPEN_EXISTING) == ERROR_SUCCESS, "unconfined read");
    require(checkFile(L"state\\serve-api.key", OPEN_EXISTING) == ERROR_SUCCESS, "unconfined key read");
    require(checkFile(L"state\\outside", OPEN_EXISTING, GENERIC_WRITE) == ERROR_SUCCESS, "unconfined outside write");
    require(checkFile(profileFile.c_str(), OPEN_EXISTING) == ERROR_SUCCESS, "unconfined profile read");
    require(checkFile(profileFile.c_str(), OPEN_EXISTING, GENERIC_WRITE) == ERROR_SUCCESS, "unconfined profile write");
    std::wstring profile = L"AtomicAgent.AclPreflight." + std::to_wstring(GetCurrentProcessId());
    PSID sid = nullptr;
    HRESULT result = CreateAppContainerProfile(profile.c_str(), profile.c_str(), L"ACL preflight",
        nullptr, 0, &sid);
    require(SUCCEEDED(result), "create AppContainer profile", static_cast<DWORD>(result));
    acl_tree::Result executableGrant;
    acl_tree::walk(executable, sid, acl_tree::readExecute, executableGrant);
    require(executableGrant.errors == 0, "grant diagnostic executable");
    acl_tree::Result projectGrant;
    acl_tree::walk(L"fixture", sid, acl_tree::modify, projectGrant);
    require(projectGrant.errors == 0 && projectGrant.objects == 4, "grant existing workspace tree");
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
    std::wstring command = L"\"" + std::wstring(executable) + L"\" --child \"" + profileFile + L"\"";
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
    acl_tree::Result revoke;
    acl_tree::walk(L"fixture", sid, 0, revoke);
    acl_tree::walk(executable, sid, 0, revoke);
    require(revoke.errors == 0, "revoke diagnostic grants");
    FreeSid(sid);
    DeleteAppContainerProfile(profile.c_str());
    require(DeleteFileW(profileFile.c_str()) != FALSE, "remove synthetic profile file");
    std::printf("probe status=%lu\n", status);
    return static_cast<int>(status);
}
