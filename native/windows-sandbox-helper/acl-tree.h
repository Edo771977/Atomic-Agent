#pragma once

#include <windows.h>
#include <aclapi.h>
#include <cstdio>
#include <cwchar>
#include <string>

namespace acl_tree {

inline constexpr DWORD readExecute = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
inline constexpr DWORD modify = readExecute | FILE_GENERIC_WRITE | DELETE;

struct Result {
    size_t objects = 0;
    size_t skipped = 0;
    size_t errors = 0;
};

inline DWORD update(HANDLE object, PSID sid, DWORD mask, bool directory) {
    PACL before = nullptr;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    DWORD error = GetSecurityInfo(object, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &before, nullptr, &descriptor);
    if (error != ERROR_SUCCESS) return error;

    // A null DACL allows all access. Never replace it with a restrictive ACL.
    if (!before) {
        LocalFree(descriptor);
        return ERROR_INVALID_ACL;
    }

    ACL_SIZE_INFORMATION info{};
    if (!GetAclInformation(before, &info, sizeof(info), AclSizeInformation)) {
        error = GetLastError();
        LocalFree(descriptor);
        return error;
    }

    const DWORD newAceSize = sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid);
    const DWORD size = info.AclBytesInUse + (mask ? newAceSize : 0);
    auto after = static_cast<PACL>(LocalAlloc(LMEM_FIXED, size));
    const DWORD flags = directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
    bool add = mask != 0;
    bool changed = false;
    if (!after) error = ERROR_OUTOFMEMORY;
    if (after && !InitializeAcl(after, size, before->AclRevision)) error = GetLastError();

    for (DWORD i = 0; error == ERROR_SUCCESS && i < info.AceCount; ++i) {
        void* raw = nullptr;
        if (!GetAce(before, i, &raw)) {
            error = GetLastError();
            break;
        }
        auto header = static_cast<ACE_HEADER*>(raw);
        if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
            auto allowed = static_cast<ACCESS_ALLOWED_ACE*>(raw);
            if (EqualSid(sid, &allowed->SidStart)) {
                if (!mask) {
                    changed = true;
                    continue;
                }
                if ((allowed->Mask & mask) == mask && !(header->AceFlags & INHERIT_ONLY_ACE) &&
                    (header->AceFlags & flags) == flags) add = false;
            }
        }
        if (add && (header->AceFlags & INHERITED_ACE)) {
            if (!AddAccessAllowedAceEx(after, before->AclRevision, flags, mask, sid)) {
                error = GetLastError();
                break;
            }
            changed = true;
            add = false;
        }
        if (!AddAce(after, before->AclRevision, MAXDWORD, raw, header->AceSize)) error = GetLastError();
    }
    if (add && error == ERROR_SUCCESS) {
        if (!AddAccessAllowedAceEx(after, before->AclRevision, flags, mask, sid)) error = GetLastError();
        changed = true;
    }

    if (changed && error == ERROR_SUCCESS) {
        SECURITY_DESCRIPTOR replacement{};
        if (!InitializeSecurityDescriptor(&replacement, SECURITY_DESCRIPTOR_REVISION) ||
            !SetSecurityDescriptorDacl(&replacement, TRUE, after, FALSE) ||
            !SetKernelObjectSecurity(object, DACL_SECURITY_INFORMATION, &replacement)) error = GetLastError();
    }
    LocalFree(after);
    LocalFree(descriptor);
    return error;
}

inline bool containsSid(const std::wstring& path, PSID sid, bool& present) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL dacl = nullptr;
    if (GetNamedSecurityInfoW(path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
        nullptr, nullptr, &dacl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
    bool valid = dacl != nullptr;
    present = false;
    for (DWORD i = 0; valid && i < dacl->AceCount; ++i) {
        void* raw = nullptr;
        valid = GetAce(dacl, i, &raw) != FALSE;
        if (valid && static_cast<ACE_HEADER*>(raw)->AceType == ACCESS_ALLOWED_ACE_TYPE &&
            EqualSid(sid, &static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart)) present = true;
    }
    LocalFree(descriptor);
    return valid;
}

inline void report(Result& result, const std::wstring& path, DWORD error) {
    ++result.errors;
    if (result.errors <= 20) std::fwprintf(stderr, L"ACL error %lu: %ls\n", error, path.c_str());
}

// Use handle-based ACL writes, one object at a time. Keep parent handles open
// without delete sharing until their subtree is complete. Never grant access to
// a reparse point or to a file with other names (potential external hard links).
inline void walk(const std::wstring& path, PSID sid, DWORD mask, Result& result,
    bool root = true, unsigned depth = 0) {
    if (depth > 256) {
        report(result, path, ERROR_DIRECTORY);
        return;
    }
    HANDLE object = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (object == INVALID_HANDLE_VALUE) {
        report(result, path, GetLastError());
        return;
    }
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(object, &info)) {
        report(result, path, GetLastError());
        CloseHandle(object);
        return;
    }
    const bool directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
        ++result.skipped;
        if (root) report(result, path, ERROR_REPARSE_TAG_INVALID);
        CloseHandle(object);
        return;
    }
    if (!directory && info.nNumberOfLinks != 1 && mask) {
        report(result, path, ERROR_TOO_MANY_LINKS);
        CloseHandle(object);
        return;
    }

    ++result.objects;
    if (result.objects % 5000 == 0) std::fprintf(stderr, "ACL objects processed: %zu\n", result.objects);
    const DWORD error = update(object, sid, mask, directory);
    if (error != ERROR_SUCCESS) report(result, path, error);

    if (directory) {
        WIN32_FIND_DATAW found{};
        HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &found);
        if (search == INVALID_HANDLE_VALUE) {
            DWORD findError = GetLastError();
            if (findError != ERROR_FILE_NOT_FOUND) report(result, path, findError);
        } else {
            do {
                const std::wstring name = found.cFileName;
                if (name != L"." && name != L"..") walk(path + L"\\" + name, sid, mask, result, false, depth + 1);
            } while (FindNextFileW(search, &found));
            DWORD findError = GetLastError();
            if (findError != ERROR_NO_MORE_FILES) report(result, path, findError);
            FindClose(search);
        }
    }
    CloseHandle(object);
}

}  // namespace acl_tree
