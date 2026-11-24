#pragma once

#include <windows.h>
#include <map>
#include <string>
#include <vector>

struct SandboxRequest {
    std::wstring profile;
    std::wstring cwd;
    std::wstring state;
    std::wstring privateTemp;
    std::wstring projectFile;
    std::wstring outsideCanary;
    std::vector<std::wstring> argv;
    std::vector<std::wstring> writableRoots;
    std::vector<std::wstring> readOnlyRoots;
    std::map<std::wstring, std::wstring> env;
    DWORD timeoutMs = INFINITE;
    DWORD verbatim = 0;
};

// Bounded parser for the exact UTF-16 JSON protocol emitted by the CLI.
class SandboxRequestParser {
public:
    explicit SandboxRequestParser(const std::wstring& input) : input_(input) {}

    bool parse(SandboxRequest& request) {
        return take(L'{') &&
            field(L"profile") && string(request.profile) && take(L',') &&
            field(L"cwd") && string(request.cwd) && take(L',') &&
            field(L"state") && string(request.state) && take(L',') &&
            field(L"privateTemp") && string(request.privateTemp) && take(L',') &&
            field(L"projectFile") && string(request.projectFile) && take(L',') &&
            field(L"outsideCanary") && string(request.outsideCanary) && take(L',') &&
            field(L"argv") && strings(request.argv) && take(L',') &&
            field(L"writableRoots") && strings(request.writableRoots) && take(L',') &&
            field(L"readOnlyRoots") && strings(request.readOnlyRoots) && take(L',') &&
            field(L"env") && environment(request.env) && take(L',') &&
            field(L"timeoutMs") && number(request.timeoutMs, INFINITE) && take(L',') &&
            field(L"verbatim") && number(request.verbatim) && request.verbatim <= 1 && take(L'}') &&
            position_ == input_.size() && !request.argv.empty() && !request.writableRoots.empty();
    }

private:
    bool take(wchar_t ch) {
        if (position_ == input_.size() || input_[position_] != ch) return false;
        ++position_;
        return true;
    }

    bool field(const wchar_t* expected) {
        std::wstring key;
        return string(key) && key == expected && take(L':');
    }

    bool string(std::wstring& text) {
        if (!take(L'"')) return false;
        while (position_ < input_.size()) {
            wchar_t ch = input_[position_++];
            if (ch == L'"') return true;
            if (ch < 32) return false;
            if (ch != L'\\') {
                text.push_back(ch);
                continue;
            }
            if (position_ == input_.size()) return false;
            switch (input_[position_++]) {
                case L'"': text.push_back(L'"'); break;
                case L'\\': text.push_back(L'\\'); break;
                case L'/': text.push_back(L'/'); break;
                case L'b': text.push_back(L'\b'); break;
                case L'f': text.push_back(L'\f'); break;
                case L'n': text.push_back(L'\n'); break;
                case L'r': text.push_back(L'\r'); break;
                case L't': text.push_back(L'\t'); break;
                case L'u': {
                    unsigned code = 0;
                    for (unsigned digit = 0; digit < 4; ++digit) {
                        if (position_ == input_.size()) return false;
                        wchar_t hex = input_[position_++];
                        if (hex >= L'0' && hex <= L'9') code = code * 16 + hex - L'0';
                        else if (hex >= L'a' && hex <= L'f') code = code * 16 + hex - L'a' + 10;
                        else if (hex >= L'A' && hex <= L'F') code = code * 16 + hex - L'A' + 10;
                        else return false;
                    }
                    if (!code) return false;
                    text.push_back(static_cast<wchar_t>(code));
                    break;
                }
                default: return false;
            }
        }
        return false;
    }

    bool number(DWORD& output, DWORD defaultValue = 0) {
        if (position_ == input_.size() || input_[position_] < L'0' || input_[position_] > L'9') return false;
        ULONGLONG parsed = 0;
        while (position_ < input_.size() && input_[position_] >= L'0' && input_[position_] <= L'9') {
            parsed = parsed * 10 + input_[position_++] - L'0';
            if (parsed > MAXDWORD) return false;
        }
        output = parsed ? static_cast<DWORD>(parsed) : defaultValue;
        return true;
    }

    bool strings(std::vector<std::wstring>& values) {
        if (!take(L'[')) return false;
        if (take(L']')) return true;
        do {
            std::wstring value;
            if (!string(value)) return false;
            values.push_back(std::move(value));
        } while (take(L','));
        return take(L']');
    }

    bool environment(std::map<std::wstring, std::wstring>& values) {
        if (!take(L'{')) return false;
        if (take(L'}')) return true;
        do {
            std::wstring key, value;
            if (!string(key) || !take(L':') || !string(value) ||
                !values.emplace(std::move(key), std::move(value)).second) return false;
        } while (take(L','));
        return take(L'}');
    }

    const std::wstring& input_;
    size_t position_ = 0;
};
