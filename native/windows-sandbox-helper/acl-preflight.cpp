#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <cstdio>
#include <string>
#include "acl-tree.h"
#include "lpac-process.h"

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

    std::wstring command = L"\"" + std::wstring(executable) + L"\" --child \"" + profileFile + L"\"";
    wchar_t systemRoot[MAX_PATH]{};
    UINT rootLength = GetWindowsDirectoryW(systemRoot, MAX_PATH);
    require(rootLength > 0 && rootLength < MAX_PATH, "locate Windows directory");
    std::wstring environment = L"SystemRoot=" + std::wstring(systemRoot);
    environment.push_back(L'\0');
    const DWORD status = runLpac(sid, executable, command, L"fixture", environment.data(), 10000, false);
    bool present = false;
    if (status == 0) {
        require(acl_tree::containsSid(L"fixture\\deep\\nested\\before", sid, present) && present,
            "find explicit SID before revocation");
        require(acl_tree::containsSid(L"fixture\\after", sid, present) && present,
            "find inherited SID before revocation");
    }
    acl_tree::Result revoke;
    acl_tree::walk(L"fixture", sid, 0, revoke);
    acl_tree::walk(executable, sid, 0, revoke);
    require(revoke.errors == 0, "revoke diagnostic grants");
    if (status == 0) {
        for (const wchar_t* path : {L"fixture", L"fixture\\deep\\nested\\before", L"fixture\\after", L"fixture\\created-by-lpac"}) {
            require(acl_tree::containsSid(path, sid, present) && !present, "verify SID removed from DACL");
        }
    }
    if (status == 0 && argc == 2 && std::wstring(argv[1]) == L"--benchmark") {
        require(CreateDirectoryW(L"fixture\\node_modules", nullptr) != FALSE, "create benchmark root");
        for (unsigned directory = 0; directory < 100; ++directory) {
            const std::wstring folder = L"fixture\\node_modules\\package-" + std::to_wstring(directory);
            require(CreateDirectoryW(folder.c_str(), nullptr) != FALSE, "create benchmark package");
            for (unsigned file = 0; file < 500; ++file) {
                const std::wstring path = folder + L"\\file-" + std::to_wstring(file);
                require(checkFile(path.c_str(), CREATE_NEW) == ERROR_SUCCESS, "create benchmark file");
            }
        }
        acl_tree::Result benchmark;
        const ULONGLONG start = GetTickCount64();
        acl_tree::walk(L"fixture", sid, acl_tree::modify, benchmark);
        std::printf("benchmark: %zu objects, %zu skips, %zu errors, %llu ms\n",
            benchmark.objects, benchmark.skipped, benchmark.errors, GetTickCount64() - start);
        require(benchmark.objects >= 50000 && benchmark.skipped == 0 && benchmark.errors == 0, "benchmark grant");
        acl_tree::Result benchmarkRevoke;
        acl_tree::walk(L"fixture", sid, 0, benchmarkRevoke);
        require(benchmarkRevoke.errors == 0, "benchmark revoke");
    }
    FreeSid(sid);
    DeleteAppContainerProfile(profile.c_str());
    require(DeleteFileW(profileFile.c_str()) != FALSE, "remove synthetic profile file");
    std::printf("probe status=%lu\n", status);
    return static_cast<int>(status);
}
