#pragma once

#include <windows.h>
#include <sddl.h>
#include <vector>

// Distinguish ordinary AppContainers from LPAC without depending on the
// TokenIsLessPrivilegedAppContainer query, which returns ERROR_INVALID_PARAMETER
// on the GitHub-hosted Windows image. The token must receive only the right
// granted to ALL RESTRICTED APPLICATION PACKAGES.
inline bool verifyPackageAccess(HANDLE token, bool lpac) {
    HANDLE impersonation = nullptr;
    if (!DuplicateToken(token, SecurityImpersonation, &impersonation)) return false;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    bool verified = false;
    if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
        L"O:SYG:SYD:(A;;0x3;;;WD)(A;;0x1;;;S-1-15-2-1)(A;;0x2;;;S-1-15-2-2)",
        SDDL_REVISION_1, &descriptor, nullptr)) {
        GENERIC_MAPPING mapping{};
        PRIVILEGE_SET privileges{};
        DWORD bytes = sizeof(privileges), granted = 0;
        BOOL allowed = FALSE;
        verified = AccessCheck(descriptor, impersonation, MAXIMUM_ALLOWED, &mapping,
            &privileges, &bytes, &granted, &allowed) && allowed && (lpac ? granted == 2 : (granted & 1) != 0);
    }
    LocalFree(descriptor);
    CloseHandle(impersonation);
    return verified;
}

inline bool verifyLpacToken(HANDLE process, PSID sid, bool lpac, const std::vector<SID_AND_ATTRIBUTES>& expected) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, &token)) return false;

    DWORD appContainer = 0, bytes = 0;
    alignas(TOKEN_APPCONTAINER_INFORMATION)
        BYTE package[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE]{};
    DWORD length = 0;
    GetTokenInformation(token, TokenCapabilities, nullptr, 0, &length);
    std::vector<BYTE> buffer(length && length <= 65536 ? length : 1);
    bool verified = GetTokenInformation(token, TokenIsAppContainer, &appContainer,
        sizeof(appContainer), &bytes) && appContainer == 1 &&
        GetTokenInformation(token, TokenCapabilities, buffer.data(), static_cast<DWORD>(buffer.size()), &bytes) &&
        GetTokenInformation(token, TokenAppContainerSid, package, sizeof(package), &bytes) &&
        EqualSid(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(package)->TokenAppContainer, sid) &&
        verifyPackageAccess(token, lpac);
    if (verified) {
        const auto groups = reinterpret_cast<const TOKEN_GROUPS*>(buffer.data());
        verified = groups->GroupCount == expected.size();
        for (DWORD i = 0; verified && i < groups->GroupCount; ++i) {
            size_t matches = 0;
            for (const auto& allowed : expected) {
                if (EqualSid(groups->Groups[i].Sid, allowed.Sid)) ++matches;
            }
            verified = matches == 1 && (groups->Groups[i].Attributes & SE_GROUP_ENABLED) != 0;
        }
    }
    CloseHandle(token);
    return verified;
}
