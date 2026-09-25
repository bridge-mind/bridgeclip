// Relocatable launcher for the hash-locked Python package. Never invokes a shell.
#include <windows.h>
#include <wchar.h>

int wmain(void) {
    wchar_t module[32768], command[32768];
    DWORD length = GetModuleFileNameW(NULL, module, 32768);
    if (!length || length >= 32768) return 1;
    wchar_t *separator = wcsrchr(module, L'\\');
    if (!separator) return 1;
    *separator = L'\0';
    const wchar_t *tail = GetCommandLineW();
    if (*tail == L'"') { tail++; while (*tail && *tail != L'"') tail++; if (*tail) tail++; }
    else { while (*tail && *tail != L' ' && *tail != L'\t') tail++; }
    if (_snwprintf_s(command, 32768, _TRUNCATE, L"\"%ls\\..\\engine-venv\\python.exe\" -m yt_dlp %ls", module, tail) < 0) return 1;
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION child = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(NULL, command, NULL, NULL, TRUE, 0, NULL, NULL, &startup, &child)) return 1;
    WaitForSingleObject(child.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(child.hProcess, &code);
    CloseHandle(child.hProcess);
    CloseHandle(child.hThread);
    return (int)code;
}
