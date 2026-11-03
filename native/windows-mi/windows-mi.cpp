// Inert Windows x64 experiment. No Run, lifecycle or cleanup authority.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mi.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#include <set>
#include <utility>
#include <new>

static constexpr size_t MaxOutput = 1024 * 1024;
static constexpr uint64_t MaxPid = 9007199254740991ULL;

static bool pidNumber(const wchar_t* text, uint64_t& result) {
    result = 0;
    if (!text || !*text || *text == L'0') return false;
    for (; *text; ++text) {
        if (*text < L'0' || *text > L'9') return false;
        unsigned digit = *text - L'0';
        if (result > (MaxPid - digit) / 10) return false;
        result = result * 10 + digit;
    }
    return result > 0;
}

// ASCII JSON escapes preserve every Windows UTF-16 code unit, including unpaired surrogates.
static bool quoted(const MI_Char* text, std::string& out) {
    if (!text) return false;
    out += '"';
    for (; *text; ++text) {
        if (out.size() > MaxOutput - 8) return false;
        char escape[7];
        sprintf_s(escape, "\\u%04x", static_cast<unsigned>(static_cast<uint16_t>(*text)));
        out += escape;
    }
    out += '"';
    return true;
}

static bool element(const MI_Instance* row, const MI_Char* name, MI_Type expected,
                    bool optional, MI_Value& value, bool& isNull) {
    MI_Type type = MI_BOOLEAN;
    MI_Uint32 flags = 0;
    if (MI_Instance_GetElement(row, name, &value, &type, &flags, nullptr) != MI_RESULT_OK) return false;
    if (type != expected) return false;
    isNull = (flags & MI_FLAG_NULL) != 0;
    return optional || !isNull;
}

static bool copyRow(const MI_Instance* row, bool shared, const std::set<uint64_t>& selected,
                    std::set<uint64_t>& seen, std::string& out) {
    MI_Value value = {};
    bool isNull = false;
    out = "{";
    if (shared) {
        if (!element(row, MI_T("ProcessId"), MI_UINT32, false, value, isNull) ||
            !selected.count(value.uint32) || !seen.insert(value.uint32).second) return false;
        out += "\"pid\":" + std::to_string(value.uint32) + ",";
    }
    if (!element(row, MI_T("CreationDate"), MI_DATETIME, false, value, isNull) ||
        value.datetime.isTimestamp != MI_TRUE) return false;
    const MI_Timestamp date = value.datetime.u.timestamp;
    out += "\"date\":{\"profile\":\"mi-timestamp-v1\",\"year\":" + std::to_string(date.year) +
        ",\"month\":" + std::to_string(date.month) + ",\"day\":" + std::to_string(date.day) +
        ",\"hour\":" + std::to_string(date.hour) + ",\"minute\":" + std::to_string(date.minute) +
        ",\"second\":" + std::to_string(date.second) + ",\"microseconds\":" + std::to_string(date.microseconds) +
        ",\"utc\":" + std::to_string(date.utc) + "}";
    for (const auto& field : { std::make_pair(MI_T("ExecutablePath"), "exe"),
                               std::make_pair(MI_T("CommandLine"), "cmd") }) {
        if (!element(row, field.first, MI_STRING, true, value, isNull)) return false;
        out += ",\"" + std::string(field.second) + "\":";
        if (isNull) out += "null";
        else if (!quoted(value.string, out)) return false;
    }
    out += "}";
    return out.size() <= MaxOutput;
}

static int failure(const char* stage) {
    printf("{\"schema\":\"native-mi-v1\",\"status\":\"%s\"}\n", stage);
    return 1;
}

int wmain(int argc, wchar_t** argv) {
    const bool shared = argc >= 2 && std::wstring(argv[1]) == L"shared";
    const bool scalar = argc >= 2 && std::wstring(argv[1]) == L"scalar";
    if ((!shared && !scalar) || argc < 3 || argc > 66 || (scalar && argc != 3)) return failure("input");
    std::set<uint64_t> selected;
    std::wstring query = shared ? L"SELECT ProcessId,CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE "
                                : L"SELECT CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE ";
    for (int i = 2; i < argc; ++i) {
        uint64_t pid;
        if (!pidNumber(argv[i], pid) || !selected.insert(pid).second) return failure("input");
        if (i > 2) query += L" OR ";
        query += L"ProcessId = " + std::to_wstring(pid);
    }
    if (query.size() > 4096) return failure("input");
    MI_Application application = MI_APPLICATION_NULL;
    MI_Instance* ownedError = nullptr;
    MI_Result result = MI_Application_Initialize(0, nullptr, &ownedError, &application);
    bool ok = true;
    if (ownedError) { if (MI_Instance_Delete(ownedError) != MI_RESULT_OK) ok = false; ownedError = nullptr; }
    if (result != MI_RESULT_OK) return failure("application");
    MI_Session session = MI_SESSION_NULL;
    result = MI_Application_NewSession(&application, MI_T("WMIDCOM"), nullptr, nullptr, nullptr, &ownedError, &session);
    if (ownedError) { if (MI_Instance_Delete(ownedError) != MI_RESULT_OK) ok = false; ownedError = nullptr; }
    if (result != MI_RESULT_OK) {
        MI_Application_Close(&application);
        return failure("session");
    }
    MI_Operation operation = MI_OPERATION_NULL;
    MI_Session_QueryInstances(&session, 0, nullptr, MI_T("root/cimv2"), MI_T("WQL"), query.c_str(), nullptr, &operation);
    std::vector<std::string> rows;
    std::set<uint64_t> seen;
    size_t bytes = 0;
    bool retrievalOk = true, operationOk = true, representationOk = true;
    MI_Boolean more = MI_TRUE;
    do {
        const MI_Instance* instance = nullptr;
        const MI_Instance* borrowedDetails = nullptr;
        const MI_Char* borrowedMessage = nullptr;
        MI_Result operationResult = MI_RESULT_FAILED;
        more = MI_TRUE;
        const MI_Result retrieved = MI_Operation_GetInstance(&operation, &instance, &more,
            &operationResult, &borrowedMessage, &borrowedDetails);
        // Completion details/message are borrowed, never deleted. Copy instance before advancing.
        if (retrieved != MI_RESULT_OK) { retrievalOk = false; continue; }
        if (operationResult != MI_RESULT_OK) operationOk = false;
        if (instance && representationOk) {
            try {
                std::string row;
                if (!copyRow(instance, shared, selected, seen, row) || rows.size() >= selected.size() ||
                    bytes + row.size() > MaxOutput - 256) representationOk = false;
                else { bytes += row.size(); rows.push_back(std::move(row)); }
            } catch (const std::bad_alloc&) {
                representationOk = false; // Still drain and close the native query after copy allocation failure.
            }
        }
    } while (more != MI_FALSE);
    // Retrieval can block. A failed retrieval is not permission to close an undrained operation.
    if (MI_Operation_Close(&operation) != MI_RESULT_OK) ok = false;
    if (MI_Session_Close(&session, nullptr, nullptr) != MI_RESULT_OK) ok = false;
    if (MI_Application_Close(&application) != MI_RESULT_OK) ok = false;
    if (!retrievalOk) return failure("retrieval");
    if (!operationOk) return failure("operation");
    if (!representationOk) return failure("representation");
    if (!ok) return failure("cleanup");
    std::string output = "{\"schema\":\"native-mi-v1\",\"status\":\"ok\",\"profile\":\"";
    output += shared ? "shared" : "scalar";
    output += "\",\"complete\":true,\"rows\":[";
    for (size_t i = 0; i < rows.size(); ++i) { if (i) output += ','; output += rows[i]; }
    output += "]}\n";
    if (output.size() > MaxOutput) return failure("representation");
    if (fwrite(output.data(), 1, output.size(), stdout) != output.size() || fflush(stdout) != 0) return 1;
    return 0;
}
