#pragma once

#include <windows.h>
#include <cstdio>
#include <string>
#include "lpac-token.h"

class LpacHandle {
public:
    LpacHandle() = default;
    explicit LpacHandle(HANDLE value) : value_(value) {}
    LpacHandle(const LpacHandle&) = delete;
    LpacHandle& operator=(const LpacHandle&) = delete;
    ~LpacHandle() { close(); }
    HANDLE get() const { return value_; }
    HANDLE* receive() { close(); return &value_; }
    explicit operator bool() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
    void close() {
        if (*this) CloseHandle(value_);
        value_ = nullptr;
    }
private:
    HANDLE value_ = nullptr;
};

class LpacAttributes {
public:
    bool create(DWORD count) {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, count, 0, &size);
        storage_ = HeapAlloc(GetProcessHeap(), 0, size);
        if (!storage_) return false;
        auto attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage_);
        if (!InitializeProcThreadAttributeList(attributes, count, 0, &size)) return false;
        value = attributes;
        return true;
    }
    ~LpacAttributes() {
        if (value) DeleteProcThreadAttributeList(value);
        if (storage_) HeapFree(GetProcessHeap(), 0, storage_);
    }
    LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
private:
    void* storage_ = nullptr;
};

inline constexpr DWORD lpacSetupFailed = 0xE0000001;
inline constexpr DWORD lpacTimedOut = 0xE0000002;

inline DWORD lpacError(const char* step, DWORD error) {
    std::fprintf(stderr, "Windows sandbox: %s failed (Win32 %lu)\n", step, error);
    return lpacSetupFailed;
}

inline DWORD runLpac(PSID sid, const wchar_t* executable, std::wstring command,
    const wchar_t* cwd, wchar_t* environment, DWORD timeout, bool inheritStdio,
    bool lpac = true, std::vector<SID_AND_ATTRIBUTES> allowed = {}) {
    LpacHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job) return lpacError("create job", GetLastError());

    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
    limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limit, sizeof(limit))) {
        return lpacError("configure job", GetLastError());
    }

    LpacAttributes attributes;
    if (!attributes.create(2 + (inheritStdio ? 1 : 0) + (lpac ? 1 : 0))) return lpacError("initialize attributes", GetLastError());

    SECURITY_CAPABILITIES capabilities{sid, allowed.empty() ? nullptr : allowed.data(),
        static_cast<DWORD>(allowed.size()), 0};
    DWORD packages = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    HANDLE jobList[] = {job.get()};
    if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
        &capabilities, sizeof(capabilities), nullptr, nullptr) ||
        (lpac && !UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
        &packages, sizeof(packages), nullptr, nullptr)) ||
        !UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        jobList, sizeof(jobList), nullptr, nullptr)) {
        return lpacError("install security and job attributes", GetLastError());
    }

    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes.value;

    constexpr DWORD streamIds[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
    constexpr DWORD streamAccess[] = {GENERIC_READ, GENERIC_WRITE, GENERIC_WRITE};
    LpacHandle streams[3];
    HANDLE allowedHandles[3]{};
    if (inheritStdio) {
        SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
        for (size_t index = 0; index < 3; ++index) {
            HANDLE original = GetStdHandle(streamIds[index]);
            if (original && original != INVALID_HANDLE_VALUE) {
                if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(),
                    streams[index].receive(), 0, TRUE, DUPLICATE_SAME_ACCESS)) {
                    return lpacError("duplicate standard handle", GetLastError());
                }
            } else {
                *streams[index].receive() = CreateFileW(L"NUL", streamAccess[index],
                    FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, 0, nullptr);
                if (!streams[index]) return lpacError("open NUL standard handle", GetLastError());
            }
            allowedHandles[index] = streams[index].get();
        }
        if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            allowedHandles, sizeof(allowedHandles), nullptr, nullptr)) {
            return lpacError("install standard handle list", GetLastError());
        }
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = allowedHandles[0];
        startup.StartupInfo.hStdOutput = allowedHandles[1];
        startup.StartupInfo.hStdError = allowedHandles[2];
    }

    PROCESS_INFORMATION created{};
    if (!CreateProcessW(executable, command.data(), nullptr, nullptr, inheritStdio,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        environment, cwd, &startup.StartupInfo, &created)) return lpacError("create suspended process", GetLastError());
    LpacHandle process(created.hProcess);
    LpacHandle thread(created.hThread);
    for (auto& stream : streams) stream.close();

    BOOL inJob = FALSE;
    if (!IsProcessInJob(process.get(), job.get(), &inJob) || !inJob) {
        TerminateProcess(process.get(), lpacSetupFailed);
        return lpacError("verify job membership", ERROR_ACCESS_DENIED);
    }
    if (!verifyLpacToken(process.get(), sid, lpac, allowed)) return lpacError("verify LPAC token", ERROR_ACCESS_DENIED);
    if (ResumeThread(thread.get()) != 1) return lpacError("resume verified process", GetLastError());

    const DWORD waited = WaitForSingleObject(process.get(), timeout);
    if (waited == WAIT_TIMEOUT) return lpacTimedOut;
    if (waited != WAIT_OBJECT_0) return lpacError("wait for process", GetLastError());
    DWORD status = lpacSetupFailed;
    if (!GetExitCodeProcess(process.get(), &status)) return lpacError("read exit code", GetLastError());
    return status;
}
