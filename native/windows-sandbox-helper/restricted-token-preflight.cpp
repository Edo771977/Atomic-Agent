#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <cstdio>
#include <string>
#include <vector>
#include "lpac-process.h"

#pragma comment(lib, "advapi32.lib")

static void require(bool valid, const char* step) {
    if (valid) return;
    std::fprintf(stderr, "%s failed (Win32 %lu)\n", step, GetLastError());
    ExitProcess(2);
}

class DiagnosticSid {
public:
    explicit DiagnosticSid(const wchar_t* text) {
        require(ConvertStringSidToSidW(text, &value) != FALSE, "decode diagnostic SID");
    }
    ~DiagnosticSid() { LocalFree(value); }
    PSID value = nullptr;
};

static std::vector<BYTE> tokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS type) {
    DWORD bytes = 0;
    GetTokenInformation(token, type, nullptr, 0, &bytes);
    require(bytes != 0, "measure token information");
    std::vector<BYTE> buffer(bytes);
    require(GetTokenInformation(token, type, buffer.data(), bytes, &bytes) != FALSE, "read token information");
    return buffer;
}

static void createFixture(const wchar_t* path, const std::wstring& sddl) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
        &descriptor, nullptr) != FALSE, "build fixture security descriptor");
    SECURITY_ATTRIBUTES security{sizeof(security), descriptor, FALSE};
    LpacHandle file(CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, &security, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL, nullptr));
    LocalFree(descriptor);
    require(static_cast<bool>(file), "create fixture with explicit DACL");
}

static DWORD probe(const wchar_t* path, DWORD access) {
    LpacHandle file(CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    return file ? ERROR_SUCCESS : GetLastError();
}

int wmain(int argc, wchar_t** argv) {
    require(argc == 2 && SetCurrentDirectoryW(argv[1]) != FALSE, "enter disposable fixture directory");
    require(CreateDirectoryW(L"project", nullptr) != FALSE, "create approved project");
    require(CreateDirectoryW(L"outside", nullptr) != FALSE, "create unapproved directory");

    LpacHandle original;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, original.receive()) != FALSE,
        "open user token");
    const auto user = tokenInfo(original.get(), TokenUser);
    wchar_t* userSid = nullptr;
    require(ConvertSidToStringSidW(reinterpret_cast<const TOKEN_USER*>(user.data())->User.Sid, &userSid) != FALSE,
        "format user SID");

    // This SID exists only in the disposable fixture and restricted tokens.
    constexpr auto dedicatedText = L"S-1-5-21-1837191948-357812498-755124268-61048";
    DiagnosticSid dedicated(dedicatedText);
    DiagnosticSid everyone(L"S-1-1-0");
    DiagnosticSid users(L"S-1-5-32-545");
    DiagnosticSid administrators(L"S-1-5-32-544");
    DiagnosticSid low(L"S-1-16-4096");

    const std::wstring userAce = L"(A;;FA;;;" + std::wstring(userSid) + L")";
    LocalFree(userSid);
    createFixture(L"project\\existing.txt", L"D:P" + userAce + L"(A;;GRGW;;;" + dedicatedText + L")S:(ML;;NW;;;LW)");
    createFixture(L"outside\\owner-only.txt", L"D:P" + userAce + L"S:(ML;;NW;;;LW)");
    createFixture(L"outside\\shared-everyone.txt", L"D:P" + userAce + L"(A;;GRGW;;;WD)S:(ML;;NW;;;LW)");
    createFixture(L"outside\\shared-users.txt", L"D:P" + userAce + L"(A;;GRGW;;;BU)S:(ML;;NW;;;LW)");

    SID_AND_ATTRIBUTES restrictTo[] = {{everyone.value, 0}, {users.value, 0}, {dedicated.value, 0}};
    SID_AND_ATTRIBUTES disable[] = {{administrators.value, 0}};
    LUID traverse{};
    require(LookupPrivilegeValueW(nullptr, L"SeChangeNotifyPrivilege", &traverse) != FALSE, "look up traversal privilege");
    const auto rawPrivileges = tokenInfo(original.get(), TokenPrivileges);
    const auto privileges = reinterpret_cast<const TOKEN_PRIVILEGES*>(rawPrivileges.data());
    std::vector<LUID_AND_ATTRIBUTES> remove;
    for (DWORD i = 0; i < privileges->PrivilegeCount; ++i) {
        const auto entry = privileges->Privileges[i];
        if (entry.Luid.LowPart != traverse.LowPart || entry.Luid.HighPart != traverse.HighPart) remove.push_back(entry);
    }
    constexpr DWORD readWrite = GENERIC_READ | GENERIC_WRITE;
    for (const auto* path : {L"project\\existing.txt", L"outside\\owner-only.txt",
        L"outside\\shared-everyone.txt", L"outside\\shared-users.txt"}) {
        require(probe(path, readWrite) == ERROR_SUCCESS, "verify unconfined fixture access");
    }

    bool contained = true;
    for (bool useLow : {false, true}) {
        LpacHandle restricted;
        require(CreateRestrictedToken(original.get(), 0, ARRAYSIZE(disable), disable,
            static_cast<DWORD>(remove.size()), remove.data(), ARRAYSIZE(restrictTo), restrictTo,
            restricted.receive()) != FALSE, "create restricted token");
        if (useLow) {
            TOKEN_MANDATORY_LABEL label{{low.value, SE_GROUP_INTEGRITY}};
            require(SetTokenInformation(restricted.get(), TokenIntegrityLevel, &label,
                sizeof(label) + GetLengthSid(low.value)) != FALSE, "set Low integrity");
        }
        const auto restrictions = tokenInfo(restricted.get(), TokenRestrictedSids);
        const auto groups = reinterpret_cast<const TOKEN_GROUPS*>(restrictions.data());
        require(groups->GroupCount == ARRAYSIZE(restrictTo), "verify restricting SID count");
        for (const auto& entry : restrictTo) {
            size_t matches = 0;
            for (DWORD i = 0; i < groups->GroupCount; ++i) if (EqualSid(entry.Sid, groups->Groups[i].Sid)) ++matches;
            require(matches == 1, "verify restricting SID");
        }
        const auto activePrivileges = tokenInfo(restricted.get(), TokenPrivileges);
        const auto remaining = reinterpret_cast<const TOKEN_PRIVILEGES*>(activePrivileges.data());
        for (DWORD i = 0; i < remaining->PrivilegeCount; ++i) {
            const auto luid = remaining->Privileges[i].Luid;
            require(luid.LowPart == traverse.LowPart && luid.HighPart == traverse.HighPart, "verify privilege removal");
        }

        LpacHandle impersonation;
        require(DuplicateToken(restricted.get(), SecurityImpersonation, impersonation.receive()) != FALSE,
            "duplicate restricted token for filesystem probe");
        require(SetThreadToken(nullptr, impersonation.get()) != FALSE, "apply restricted token");
        const DWORD project = probe(L"project\\existing.txt", readWrite);
        const DWORD privateFile = probe(L"outside\\owner-only.txt", GENERIC_READ);
        const DWORD publicRead = probe(L"outside\\shared-everyone.txt", GENERIC_READ);
        const DWORD publicWrite = probe(L"outside\\shared-everyone.txt", GENERIC_WRITE);
        const DWORD usersRead = probe(L"outside\\shared-users.txt", GENERIC_READ);
        const DWORD usersWrite = probe(L"outside\\shared-users.txt", GENERIC_WRITE);
        const DWORD nullDevice = probe(L"NUL", readWrite);
        require(RevertToSelf() != FALSE, "restore user token");
        std::printf("%s: project=%lu owner-only=%lu Everyone(read=%lu write=%lu) Users(read=%lu write=%lu) NUL=%lu\n",
            useLow ? "Low integrity" : "original integrity", project, privateFile, publicRead, publicWrite,
            usersRead, usersWrite, nullDevice);
        require(project == ERROR_SUCCESS && privateFile == ERROR_ACCESS_DENIED, "verify fixture controls");
        contained &= publicRead == ERROR_ACCESS_DENIED && publicWrite == ERROR_ACCESS_DENIED &&
            usersRead == ERROR_ACCESS_DENIED && usersWrite == ERROR_ACCESS_DENIED;
    }
    if (!contained) std::fprintf(stderr, "Restricted token did not confine access to the approved project.\n");
    return contained ? 0 : 1;
}
