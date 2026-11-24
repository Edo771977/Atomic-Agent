#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <sddl.h>
#include <userenv.h>
#include <cstdio>
#include <string>
#include "acl-tree.h"
#include "lpac-process.h"
#include "network-winrt.h"
#include "sandbox-paths.h"
#include "sandbox-request.h"

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "ws2_32.lib")

class SandboxSid {
public:
    ~SandboxSid() { if (value) FreeSid(value); }
    PSID value = nullptr;
};

static bool profileName(const std::wstring& name) {
    const std::wstring prefix = L"AtomicAgent.Workspace.";
    return name.size() == prefix.size() + 32 && name.starts_with(prefix) &&
        name.find_first_not_of(L"0123456789abcdef", prefix.size()) == std::wstring::npos;
}

static bool openProfile(const std::wstring& profile, SandboxSid& sid, bool create) {
    if (!profileName(profile)) return false;
    if (create) {
        const HRESULT result = CreateAppContainerProfile(profile.c_str(), profile.c_str(),
            L"Atomic Agent workspace", nullptr, 0, &sid.value);
        if (SUCCEEDED(result)) return true;
        if (result != HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) return false;
    }
    return SUCCEEDED(DeriveAppContainerSidFromAppContainerName(profile.c_str(), &sid.value));
}

static bool isOperator() {
    SetLastError(ERROR_SUCCESS);
    if (GetEnvironmentVariableW(L"ATOMIC_AGENT_TOOL_CHILD", nullptr, 0) != 0 ||
        GetLastError() != ERROR_ENVVAR_NOT_FOUND) return false;
    LpacHandle token;
    DWORD appContainer = 1, length = 0;
    return OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token.receive()) &&
        GetTokenInformation(token.get(), TokenIsAppContainer, &appContainer, sizeof(appContainer), &length) &&
        appContainer == 0;
}

static int initState(const std::wstring& state, const std::wstring& folder) {
    if (!localAclTree(state, true) || !windowsPathEqual(folder, state + L"\\windows-sandbox")) return 4;
    LpacHandle token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token.receive())) return 4;
    alignas(TOKEN_USER) BYTE info[sizeof(TOKEN_USER) + SECURITY_MAX_SID_SIZE]{};
    DWORD bytes = 0;
    if (!GetTokenInformation(token.get(), TokenUser, &info, sizeof(info), &bytes)) return 4;
    PSID user = reinterpret_cast<const TOKEN_USER*>(info)->User.Sid;
    wchar_t* userSid = nullptr;
    if (!ConvertSidToStringSidW(user, &userSid)) return 4;
    const std::wstring sddl = L"O:" + std::wstring(userSid) + L"D:P(A;OICI;FA;;;" + userSid + L")";
    LocalFree(userSid);
    PSECURITY_DESCRIPTOR privateDacl = nullptr;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
        &privateDacl, nullptr)) return 4;
    SECURITY_ATTRIBUTES security{sizeof(security), privateDacl, FALSE};
    const BOOL created = CreateDirectoryW(folder.c_str(), &security);
    const DWORD createError = created ? ERROR_SUCCESS : GetLastError();
    LocalFree(privateDacl);
    if (!created && createError != ERROR_ALREADY_EXISTS) return 4;

    LpacHandle directory(CreateFileW(folder.c_str(), READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!directory || !localAclTree(folder, true)) return 4;
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL dacl = nullptr;
    PSID owner = nullptr;
    if (GetSecurityInfo(directory.get(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
        &owner, nullptr, &dacl, nullptr, &descriptor) != ERROR_SUCCESS) return 4;
    SECURITY_DESCRIPTOR_CONTROL controls = 0;
    DWORD revision = 0;
    void* entry = nullptr;
    const bool valid = owner && EqualSid(owner, user) && dacl && dacl->AceCount == 1 &&
        GetSecurityDescriptorControl(descriptor, &controls, &revision) && (controls & SE_DACL_PROTECTED) &&
        GetAce(dacl, 0, &entry) && static_cast<ACE_HEADER*>(entry)->AceType == ACCESS_ALLOWED_ACE_TYPE &&
        (static_cast<ACE_HEADER*>(entry)->AceFlags & (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) ==
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) &&
        EqualSid(&static_cast<ACCESS_ALLOWED_ACE*>(entry)->SidStart, user) &&
        (static_cast<ACCESS_ALLOWED_ACE*>(entry)->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS;
    LocalFree(descriptor);
    if (!valid) return static_cast<int>(lpacError("verify private state directory ACL", ERROR_ACCESS_DENIED));
    return 0;
}

static int changeGrants(int argc, wchar_t** argv, bool revoke) {
    if (argc < 5 || !isOperator()) return static_cast<int>(lpacError("require operator session", ERROR_ACCESS_DENIED));
    SandboxSid sid;
    if (!openProfile(argv[2], sid, !revoke)) return static_cast<int>(lpacError("open sandbox profile", ERROR_INVALID_SID));

    // The first path is the project, the optional remaining paths are explicitly
    // approved runtime shares belonging to this project's container SID.
    for (int index = 4; index < argc; ++index) {
        if (!sandboxGrantRoot(argv[index], argv[3], index == 4)) {
            return static_cast<int>(lpacError("validate local ACL root", ERROR_ACCESS_DENIED));
        }
    }
    acl_tree::Result result;
    for (int index = 4; index < argc; ++index) {
        const DWORD rights = index == 4 ? acl_tree::modify : acl_tree::readExecute;
        acl_tree::walk(argv[index], sid.value, revoke ? 0 : rights, result);
    }
    wchar_t* sidString = nullptr;
    if (!ConvertSidToStringSidW(sid.value, &sidString)) return static_cast<int>(lpacError("format SID", GetLastError()));
    std::printf("%ls\t%zu\t%zu\t%zu\n", sidString, result.objects, result.skipped, result.errors);
    LocalFree(sidString);
    return result.errors == 0 ? 0 : 4;
}

static std::wstring quoteArgument(const std::wstring& argument) {
    std::wstring result = L"\"";
    size_t backslashes = 0;
    for (wchar_t ch : argument) {
        if (ch == L'\\') {
            ++backslashes;
            continue;
        }
        result.append(backslashes * (ch == L'"' ? 2 : 1) + (ch == L'"' ? 1 : 0), L'\\');
        result.push_back(ch);
        backslashes = 0;
    }
    result.append(backslashes * 2, L'\\');
    result.push_back(L'"');
    return result;
}

static bool loadRequest(const wchar_t* path, SandboxRequest& request) {
    LpacHandle input(CreateFileW(path, GENERIC_READ | DELETE, 0, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_DELETE_ON_CLOSE | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!input) return false;
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(input.get(), &size) || size.QuadPart < 2 || size.QuadPart > 256 * 1024 ||
        size.QuadPart % sizeof(wchar_t)) return false;
    std::wstring json(static_cast<size_t>(size.QuadPart) / sizeof(wchar_t), L'\0');
    DWORD bytes = 0;
    if (!ReadFile(input.get(), json.data(), static_cast<DWORD>(size.QuadPart), &bytes, nullptr) ||
        bytes != size.QuadPart) return false;
    return SandboxRequestParser(json).parse(request);
}

static std::wstring childEnvironment(const SandboxRequest& request) {
    std::map<std::wstring, std::wstring> settings = {
        {L"APPDATA", request.privateTemp}, {L"ATOMIC_AGENT_TOOL_CHILD", L"1"},
        {L"GIT_CONFIG_GLOBAL", L"NUL"}, {L"GIT_CONFIG_NOSYSTEM", L"1"},
        {L"GIT_OPTIONAL_LOCKS", L"0"}, {L"HOME", request.privateTemp},
        {L"LOCALAPPDATA", request.privateTemp}, {L"SystemRoot", getSandboxWindowsDir()},
        {L"SystemDrive", getSandboxWindowsDir().substr(0, 2)}, {L"windir", getSandboxWindowsDir()},
        {L"TEMP", request.privateTemp}, {L"TMP", request.privateTemp}, {L"USERPROFILE", request.privateTemp},
    };
    std::wstring path;
    for (const auto& root : request.readOnlyRoots) {
        if (!path.empty()) path += L';';
        auto attributes = GetFileAttributesW(root.c_str());
        path += (attributes & FILE_ATTRIBUTE_DIRECTORY) ? root : root.substr(0, root.find_last_of(L'\\'));
    }
    const std::wstring windows = getSandboxWindowsDir();
    if (!path.empty()) path += L';';
    path += windows + L"\\System32";
    settings.emplace(L"PATH", path);
    for (const wchar_t* name : {L"LANG", L"LC_ALL", L"NO_COLOR", L"TERM"}) {
        const auto value = request.env.find(name);
        if (value != request.env.end()) settings.emplace(value->first, value->second);
    }
#ifdef ATOMIC_SANDBOX_DIAGNOSTICS
    settings.emplace(L"PATHEXT", L".COM;.EXE;.BAT;.CMD");
    if (request.env.count(L"ATOMIC_DIAGNOSTIC_GIT")) {
        settings.emplace(L"GIT_TRACE", L"1");
        settings.emplace(L"GIT_TRACE2_EVENT", L"1");
        settings.emplace(L"GIT_PAGER", L"");
        settings.emplace(L"GIT_TERMINAL_PROMPT", L"0");
        settings.emplace(L"GIT_CONFIG_COUNT", L"3");
        settings.emplace(L"GIT_CONFIG_KEY_0", L"core.fsmonitor");
        settings.emplace(L"GIT_CONFIG_VALUE_0", L"false");
        settings.emplace(L"GIT_CONFIG_KEY_1", L"core.hooksPath");
        settings.emplace(L"GIT_CONFIG_VALUE_1", L"");
        settings.emplace(L"GIT_CONFIG_KEY_2", L"credential.helper");
        settings.emplace(L"GIT_CONFIG_VALUE_2", L"");
        if (request.env.count(L"ATOMIC_DIAGNOSTIC_EMPTY_CONFIG")) {
            settings[L"GIT_CONFIG_GLOBAL"] = request.privateTemp + L"\\empty-git-config";
        }
    }
#endif
    std::wstring block;
    for (const auto& entry : settings) {
        block += entry.first + L'=' + entry.second;
        block.push_back(L'\0');
    }
    return block;
}

static DWORD fileProbe(const wchar_t* path, DWORD access) {
    LpacHandle file(CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    return file ? ERROR_SUCCESS : GetLastError();
}

static SOCKET loopbackListener(unsigned short& port) {
    SOCKET server = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (server == INVALID_SOCKET) return server;
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    int length = sizeof(address);
    if (bind(server, reinterpret_cast<sockaddr*>(&address), length) == 0 &&
        listen(server, 2) == 0 && getsockname(server, reinterpret_cast<sockaddr*>(&address), &length) == 0) {
        port = ntohs(address.sin_port);
        return server;
    }
    closesocket(server);
    return INVALID_SOCKET;
}

static int tcpConnect(const wchar_t* host, unsigned short port) {
    SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (client == INVALID_SOCKET) return WSAGetLastError();
    sockaddr_in address{};
    address.sin_family = AF_INET;
    if (InetPtonW(AF_INET, host, &address.sin_addr) != 1) {
        closesocket(client);
        return WSAEINVAL;
    }
    address.sin_port = htons(port);
    const int connected = connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address));
    const int result = connected == 0 ? 0 : WSAGetLastError();
    closesocket(client);
    return result;
}

static int startWinsock() {
    WSADATA information{};
    return WSAStartup(MAKEWORD(2, 2), &information);
}

static int networkProbe(const wchar_t* host, unsigned short port) {
    const int startup = startWinsock();
    if (startup == 0) {
        const int status = tcpConnect(host, port);
        WSACleanup();
        return status;
    }
    std::fprintf(stderr, "WSAStartup result: %d; trying StreamSocket\n", startup);
    const HRESULT fallback = connectWinRt(host, port);
    if (fallback == S_OK) return 0;
    if (fallback == E_ACCESSDENIED) return WSAEACCES;
    return startup;
}

static int probeChild(wchar_t** argv) {
    const DWORD readProject = fileProbe(argv[2], GENERIC_READ);
    const DWORD readKey = fileProbe(argv[3], GENERIC_READ);
    const DWORD writeOutside = fileProbe(argv[4], GENERIC_WRITE);
    const int network = networkProbe(L"127.0.0.1", static_cast<unsigned short>(std::wcstoul(argv[5], nullptr, 10)));
    if (readProject == ERROR_SUCCESS && readKey == ERROR_ACCESS_DENIED &&
        writeOutside == ERROR_ACCESS_DENIED && network == WSAEACCES) return 0;
    std::fprintf(stderr, "Windows sandbox probe failed (project=%lu, state=%lu, outside=%lu, loopback=%d)\n",
        readProject, readKey, writeOutside, network);
    return 5;
}

static bool grantTemp(const SandboxRequest& request, PSID sid) {
    LpacHandle directory(CreateFileW(request.privateTemp.c_str(), READ_CONTROL | WRITE_DAC,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    return directory && acl_tree::update(directory.get(), sid, acl_tree::modify, true) == ERROR_SUCCESS;
}

#ifdef ATOMIC_SANDBOX_DIAGNOSTICS
static constexpr const wchar_t* diagnosticNames[] = {
    L"registryRead", L"lpacCom", L"lpacAppExperience", L"lpacInstrumentation",
    L"lpacCryptoServices", L"lpacIdentityServices", L"lpacPnPNotifications",
    L"lpacServicesManagement", L"lpacSessionManagement",
};

class DiagnosticCapabilities {
public:
    ~DiagnosticCapabilities() { for (auto sid : owned) LocalFree(sid); }
    bool add(const std::wstring& name) {
        bool known = false;
        for (const auto* candidate : diagnosticNames) if (name == candidate) known = true;
        if (!known) return false;
        using Derive = BOOL (WINAPI*)(LPCWSTR, PSID**, DWORD*, PSID**, DWORD*);
        const auto derive = reinterpret_cast<Derive>(
            GetProcAddress(GetModuleHandleW(L"kernelbase.dll"), "DeriveCapabilitySidsFromName"));
        PSID* groups = nullptr;
        PSID* sids = nullptr;
        DWORD groupCount = 0, count = 0;
        if (!derive || !derive(name.c_str(), &groups, &groupCount, &sids, &count)) return false;
        for (DWORD i = 0; i < groupCount; ++i) LocalFree(groups[i]);
        LocalFree(groups);
        bool valid = count == 1 && IsValidSid(sids[0]);
        for (DWORD i = 0; i < count; ++i) {
            owned.push_back(sids[i]);
            for (const auto& previous : values) if (EqualSid(previous.Sid, sids[i])) valid = false;
        }
        if (valid) values.push_back({sids[0], SE_GROUP_ENABLED});
        LocalFree(sids);
        return valid;
    }

    std::vector<SID_AND_ATTRIBUTES> values;
private:
    std::vector<PSID> owned;
};

static int diagnose(int argc, wchar_t** argv) {
    SandboxRequest request;
    SandboxSid sid;
    if (argc < 4 || !loadRequest(argv[2], request) || !openProfile(request.profile, sid, false) ||
        !sandboxGrantRoot(request.privateTemp, request.state, true, true) || !grantTemp(request, sid.value)) return 4;
    const std::wstring mode = argv[3];
    const bool lpac = mode == L"lpac";
    if (!lpac && (mode != L"appcontainer" || argc != 4)) return 4;
    DiagnosticCapabilities caps;
    for (int i = 4; i < argc; ++i) {
        if (!caps.add(argv[i])) return static_cast<int>(lpacError("derive allowlisted diagnostic SID", GetLastError()));
    }
    const auto& application = request.argv.front();
    if (!dosPath(application)) return 4;
    std::wstring command = quoteArgument(application);
    for (size_t i = 1; i < request.argv.size(); ++i) command += L" " + quoteArgument(request.argv[i]);
    auto environment = childEnvironment(request);
    return static_cast<int>(runLpac(sid.value, application.c_str(), command, request.cwd.c_str(),
        environment.data(), request.timeoutMs, true, lpac, caps.values));
}

static constexpr DWORD ancestorAttributes = FILE_READ_ATTRIBUTES | SYNCHRONIZE;

static bool diagnosticAncestorAce(HANDLE directory, PSID sid, bool expected) {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    PACL dacl = nullptr;
    if (GetSecurityInfo(directory, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr,
        &dacl, nullptr, &descriptor) != ERROR_SUCCESS) return false;
    DWORD count = 0;
    bool exact = true;
    for (WORD i = 0; dacl && i < dacl->AceCount; ++i) {
        void* raw = nullptr;
        if (!GetAce(dacl, i, &raw)) { exact = false; break; }
        const auto* ace = static_cast<const ACCESS_ALLOWED_ACE*>(raw);
        if (ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && EqualSid(sid, const_cast<DWORD*>(&ace->SidStart))) {
            ++count;
            if (ace->Header.AceFlags != 0 || ace->Mask != ancestorAttributes) exact = false;
        }
    }
    LocalFree(descriptor);
    return dacl && exact && count == (expected ? 1u : 0u);
}

static int diagnosticAncestors(wchar_t** argv) {
    const std::wstring mode = argv[2];
    const std::wstring root = argv[5];
    const bool grant = mode == L"grant";
    const bool revoke = mode == L"revoke";
    SandboxSid sid;
    if ((!grant && !revoke && mode != L"absent") || !isOperator() ||
        !sandboxGrantRoot(root, argv[4], true) || !openProfile(argv[3], sid, false)) return 4;

    size_t errors = 0;
    auto path = root;
    while (path.size() > 3) {
        const auto separator = path.find_last_of(L'\\');
        path.resize(separator == 2 ? 3 : separator);
        const DWORD access = READ_CONTROL | ((grant || revoke) ? WRITE_DAC : 0);
        LpacHandle directory(CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!directory) {
            std::fwprintf(stderr, L"Ancestor ACL open failed at %ls: %lu\n", path.c_str(), GetLastError());
            ++errors;
            continue;
        }
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(directory.get(), &info) ||
            (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
            !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ||
            !acl_tree::isSamePath(directory.get(), path)) {
            std::fwprintf(stderr, L"Ancestor path validation failed at %ls\n", path.c_str());
            ++errors;
            continue;
        }
        const DWORD status = grant || revoke ? acl_tree::update(directory.get(), sid.value,
            grant ? ancestorAttributes : 0, false) : ERROR_SUCCESS;
        if (status != ERROR_SUCCESS || !diagnosticAncestorAce(directory.get(), sid.value, grant)) {
            std::fwprintf(stderr, L"Ancestor ACL %ls failed at %ls: %lu\n", mode.c_str(), path.c_str(), status);
            ++errors;
        } else {
            std::wprintf(L"Ancestor ACL %ls: %ls\n", mode.c_str(), path.c_str());
        }
    }
    return errors == 0 ? 0 : 4;
}

static int diagnosticNullDevice(bool expectAccess) {
    LpacHandle device(CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    const DWORD result = device ? ERROR_SUCCESS : GetLastError();
    std::printf("NUL read/write result: %lu\n", result);
    return result == (expectAccess ? ERROR_SUCCESS : ERROR_ACCESS_DENIED) ? 0 : 5;
}

static int diagnosticFile(wchar_t** argv) {
    const std::wstring kind = argv[2];
    const DWORD access = kind == L"write-deny" ? GENERIC_WRITE : GENERIC_READ;
    const DWORD result = fileProbe(argv[3], access);
    std::printf("FILE result: %lu\n", result);
    return result == (kind == L"read-allow" ? ERROR_SUCCESS : ERROR_ACCESS_DENIED) ? 0 : 5;
}
#endif

static int run(const wchar_t* file) {
    SandboxRequest request;
    SandboxSid sid;
    if (!loadRequest(file, request) || !openProfile(request.profile, sid, false) ||
        !sandboxGrantRoot(request.privateTemp, request.state, true, true) || !localAclTree(request.cwd, true)) {
        return static_cast<int>(lpacError("validate launch request", ERROR_INVALID_PARAMETER));
    }

    bool cwdAllowed = false, projectFileAllowed = false;
    for (const auto& root : request.writableRoots) {
        if (!sandboxGrantRoot(root, request.state, true)) {
            return static_cast<int>(lpacError("validate workspace", ERROR_ACCESS_DENIED));
        }
        cwdAllowed = cwdAllowed || windowsContains(root, request.cwd);
        projectFileAllowed = projectFileAllowed || windowsContains(root, request.projectFile);
    }
    if (!cwdAllowed || !projectFileAllowed || !localAclTree(request.projectFile, false) ||
        !windowsContains(request.state, request.outsideCanary) || !grantTemp(request, sid.value)) {
        return static_cast<int>(lpacError("validate workspace and temporary directory", ERROR_ACCESS_DENIED));
    }
    for (const auto& path : request.readOnlyRoots) {
        if (!sandboxGrantRoot(path, request.state, false)) {
            return static_cast<int>(lpacError("validate read-only runtime", ERROR_ACCESS_DENIED));
        }
    }

    acl_tree::Result audits;
    for (const auto& path : request.writableRoots) acl_tree::walk(path, sid.value, acl_tree::modify, audits, true);
    for (const auto& path : request.readOnlyRoots) acl_tree::walk(path, sid.value, acl_tree::readExecute, audits, true);
    if (audits.errors) {
        std::fprintf(stderr, "ACL verification failed on %zu path(s)\n", audits.errors);
        return static_cast<int>(lpacError("verify registered grants; reopen the project in the TUI to regrant", ERROR_ACCESS_DENIED));
    }
    auto key = request.state + L"\\serve-api.key";
    if (GetFileAttributesW(key.c_str()) == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND) key = request.outsideCanary;
    if (fileProbe(key.c_str(), GENERIC_READ) != ERROR_SUCCESS ||
        fileProbe(request.outsideCanary.c_str(), GENERIC_WRITE) != ERROR_SUCCESS) {
        return static_cast<int>(lpacError("establish state fixture reference access", ERROR_ACCESS_DENIED));
    }
    wchar_t executable[32768]{};
    DWORD pathLength = GetModuleFileNameW(nullptr, executable, ARRAYSIZE(executable));
    if (!pathLength || pathLength >= ARRAYSIZE(executable) || startWinsock() != 0) {
        return static_cast<int>(lpacError("initialize sandbox probe", ERROR_INVALID_DATA));
    }
    unsigned short port = 0;
    SOCKET listener = loopbackListener(port);
    if (listener == INVALID_SOCKET || tcpConnect(L"127.0.0.1", port) != 0) {
        if (listener != INVALID_SOCKET) closesocket(listener);
        WSACleanup();
        return static_cast<int>(lpacError("establish loopback probe reference access", ERROR_ACCESS_DENIED));
    }
    std::wstring probe = quoteArgument(executable) + L" --probe-child " + quoteArgument(request.projectFile) +
        L" " + quoteArgument(key) + L" " + quoteArgument(request.outsideCanary) + L" " + std::to_wstring(port);
    auto environment = childEnvironment(request);
    const DWORD probeStatus = runLpac(sid.value, executable, probe, request.cwd.c_str(), environment.data(), 5000, true);
    closesocket(listener);
    WSACleanup();
    if (probeStatus != 0) return static_cast<int>(lpacError("verify workspace grant and network isolation; reopen the project in the TUI to regrant", probeStatus));

    const std::wstring& application = request.argv.front();
    if (!dosPath(application)) return static_cast<int>(lpacError("require absolute command path", ERROR_INVALID_NAME));
    std::wstring command = quoteArgument(application);
    for (size_t index = 1; index < request.argv.size(); ++index) {
        command += L' ';
        command += request.verbatim ? request.argv[index] : quoteArgument(request.argv[index]);
    }
    return static_cast<int>(runLpac(sid.value, application.c_str(), command, request.cwd.c_str(),
        environment.data(), request.timeoutMs, true));
}

int wmain(int argc, wchar_t** argv) {
    const std::wstring action = argc > 1 ? argv[1] : L"";
    if (action == L"--probe-child" && argc == 6) return probeChild(argv);
    if ((action == L"--socket-allow" || action == L"--socket-deny") && argc == 4) {
        const int status = networkProbe(argv[2], static_cast<unsigned short>(std::wcstoul(argv[3], nullptr, 10)));
        std::printf("TCP result: %d\n", status);
        return status == (action == L"--socket-allow" ? 0 : WSAEACCES) ? 0 : 5;
    }
    if (action == L"--socket-winrt-allow" && argc == 4) {
        return connectWinRt(argv[2], static_cast<unsigned short>(std::wcstoul(argv[3], nullptr, 10))) == S_OK ? 0 : 5;
    }
#ifdef ATOMIC_SANDBOX_DIAGNOSTICS
    if (action == L"--null-device-host" && argc == 2) return diagnosticNullDevice(true);
    if (action == L"--null-device-deny" && argc == 2) return diagnosticNullDevice(false);
    if (action == L"--ancestor-acl" && argc == 6) return diagnosticAncestors(argv);
    if (action == L"diagnose") return diagnose(argc, argv);
    if (action == L"--file-check" && argc == 4) return diagnosticFile(argv);
#endif
    if (action == L"init-state" && argc == 4) return initState(argv[2], argv[3]);
    if (action == L"run" && argc == 3) return run(argv[2]);
    if (action == L"grant" || action == L"revoke") return changeGrants(argc, argv, action == L"revoke");
    return static_cast<int>(lpacError("read helper arguments", ERROR_INVALID_PARAMETER));
}
