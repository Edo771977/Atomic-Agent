#pragma once

#include <windows.h>
#include <sddl.h>

// Distinguish ordinary AppContainers from LPAC without depending on the
// TokenIsLessPrivilegedAppContainer query, which returns ERROR_INVALID_PARAMETER
// on the GitHub-hosted Windows image. The token must receive only the right
// granted to ALL RESTRICTED APPLICATION PACKAGES.
inline bool grantsOnlyRestrictedPackages(HANDLE token) {
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
            &privileges, &bytes, &granted, &allowed) && allowed && granted == 2;
    }
    LocalFree(descriptor);
    CloseHandle(impersonation);
    return verified;
}

inline bool verifyLpacToken(HANDLE process, PSID sid) {
    HANDLE token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, &token)) return false;

    DWORD appContainer = 0, bytes = 0;
    alignas(TOKEN_GROUPS) BYTE capabilities[sizeof(TOKEN_GROUPS)]{};
    alignas(TOKEN_APPCONTAINER_INFORMATION)
        BYTE package[sizeof(TOKEN_APPCONTAINER_INFORMATION) + SECURITY_MAX_SID_SIZE]{};
    const bool verified = GetTokenInformation(token, TokenIsAppContainer, &appContainer,
        sizeof(appContainer), &bytes) && appContainer == 1 &&
        GetTokenInformation(token, TokenCapabilities, capabilities, sizeof(capabilities), &bytes) &&
        reinterpret_cast<const TOKEN_GROUPS*>(capabilities)->GroupCount == 0 &&
        GetTokenInformation(token, TokenAppContainerSid, package, sizeof(package), &bytes) &&
        EqualSid(reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(package)->TokenAppContainer, sid) &&
        grantsOnlyRestrictedPackages(token);
    CloseHandle(token);
    return verified;
}
