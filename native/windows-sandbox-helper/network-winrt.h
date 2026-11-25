#pragma once

#include <windows.h>
#include <cstdio>
#include <string>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Networking.h>
#include <winrt/Windows.Networking.Sockets.h>

#pragma comment(lib, "windowsapp.lib")

// Try a documented second TCP client API if the Winsock catalog cannot
// initialize. Require an explicit access-denied result, and never convert a
// generic provider, resolver or timeout error into a successful negative test.
inline HRESULT connectWinRt(const wchar_t* address, unsigned short port) {
    const char* stage = "initialize";
    HRESULT status = S_OK;
    bool initialized = false;
    try {
        winrt::init_apartment(winrt::apartment_type::multi_threaded);
        initialized = true;
        stage = "create StreamSocket";
        winrt::Windows::Networking::Sockets::StreamSocket socket;
        winrt::Windows::Networking::HostName host(address);
        stage = "connect StreamSocket";
        socket.ConnectAsync(host, winrt::to_hstring(port)).get();
        socket.Close();
    } catch (const winrt::hresult_error& error) {
        status = error.code();
    } catch (...) {
        status = E_FAIL;
    }
    if (initialized) winrt::uninit_apartment();
    std::fprintf(stderr, "StreamSocket %s result: 0x%08lx\n", stage, static_cast<unsigned long>(status));
    // An access error from COM apartment initialization is inconclusive.
    return initialized ? status : E_UNEXPECTED;
}
