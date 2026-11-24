#pragma once

#include <windows.h>
#include <userenv.h>
#include <cwchar>
#include <string>
#include "lpac-process.h"

inline bool windowsPathEqual(const std::wstring& left, const std::wstring& right) {
    return CompareStringOrdinal(left.data(), static_cast<int>(left.size()), right.data(),
        static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

inline bool windowsContains(const std::wstring& root, const std::wstring& path) {
    return windowsPathEqual(root, path) ||
        (path.size() > root.size() && (root.back() == L'\\' || path[root.size()] == L'\\') &&
            windowsPathEqual(root, path.substr(0, root.size())));
}

inline bool dosPath(const std::wstring& path) {
    return path.size() >= 3 && ((path[0] >= L'A' && path[0] <= L'Z') ||
        (path[0] >= L'a' && path[0] <= L'z')) && path[1] == L':' && path[2] == L'\\' &&
        path.find_first_of(L":*/?<>|", 3) == std::wstring::npos;
}

inline bool localAclTree(const std::wstring& path, bool directory) {
    if (!dosPath(path) || path.size() < 4) return false;
    LpacHandle object(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!object) return false;
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(object.get(), &info) ||
        (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        (directory && !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))) return false;
    wchar_t resolved[32768]{};
    const DWORD length = GetFinalPathNameByHandleW(object.get(), resolved, ARRAYSIZE(resolved), FILE_NAME_NORMALIZED);
    if (length < 5 || length >= ARRAYSIZE(resolved) ||
        !windowsPathEqual(path, std::wstring(resolved + 4, length - 4))) return false;

    DWORD volumeFlags = 0;
    return GetVolumeInformationByHandleW(object.get(), nullptr, 0, nullptr, nullptr, &volumeFlags, nullptr, 0) &&
        (volumeFlags & FILE_PERSISTENT_ACLS) != 0;
}

inline std::wstring getSandboxWindowsDir() {
    wchar_t value[MAX_PATH]{};
    const UINT length = GetWindowsDirectoryW(value, ARRAYSIZE(value));
    return length > 0 && length < ARRAYSIZE(value) ? std::wstring(value, length) : L"";
}

inline std::wstring getSandboxProfileDir() {
    LpacHandle token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token.receive())) return L"";
    wchar_t profile[32768]{};
    DWORD length = ARRAYSIZE(profile);
    return GetUserProfileDirectoryW(token.get(), profile, &length) ? std::wstring(profile) : L"";
}

inline bool isSandboxExecutable(const std::wstring& path) {
    wchar_t executable[32768]{};
    DWORD length = GetModuleFileNameW(nullptr, executable, ARRAYSIZE(executable));
    return length > 0 && length < ARRAYSIZE(executable) &&
        windowsPathEqual(path, std::wstring(executable, length));
}

inline bool sandboxGrantRoot(const std::wstring& root, const std::wstring& state,
    bool writable, bool isPrivateTemp = false) {
    if (!dosPath(state) || !localAclTree(root, writable)) return false;
    const std::wstring home = getSandboxProfileDir();
    const std::wstring windows = getSandboxWindowsDir();
    if (home.empty() || windows.empty()) return false;
    if (windowsContains(root, home) || windowsContains(root, windows) || windowsContains(windows, root) ||
        windowsContains(root, state)) return false;
    if (isPrivateTemp) return windowsContains(state, root);
    if (windowsContains(state, root) || (!writable && windowsContains(home, root) && !isSandboxExecutable(root))) return false;

    // Reject broad shared-system roots. Read-only grants may target a
    // specific runtime installation there if the operator owns its ACLs.
    const std::wstring drive = windows.substr(0, 3);
    for (const wchar_t* name : {L"Program Files", L"Program Files (x86)", L"ProgramData"}) {
        const std::wstring system = drive + name;
        if (windowsContains(root, system) || (writable && windowsContains(system, root))) return false;
    }
    return true;
}
