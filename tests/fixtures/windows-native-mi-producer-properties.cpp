// Test-only actual producer, compiled on Windows with real SDK types and synthetic MI ports.
// No provider calls: injected faults/counters do not prove provider parity or physical cleanup.
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
#include <cstdarg>
#include <cstring>
#include <cwchar>
#include <algorithm>

static_assert(sizeof(MI_Char) == 2 && sizeof(wchar_t) == 2, "Windows UTF16 required");
namespace fixture {
struct Row {
    MI_Uint32 pid = 1;
    MI_Type pidType = MI_UINT32, dateType = MI_DATETIME;
    MI_Type exeType = MI_STRING, cmdType = MI_STRING;
    bool pidNull = false, dateNull = false, exeNull = false, cmdNull = false;
    bool missingPid = false, missingDate = false, timestamp = true, copyFault = false;
    std::wstring exe = L"E", cmd = L"C";
};
struct Record {
    Row row;
    bool instance = true;
    MI_Result retrieval = MI_RESULT_OK, operation = MI_RESULT_OK;
};
struct State {
    std::vector<Record> records;
    Row borrowed;
    MI_Instance instance = {}, details = {}, owned = {};
    size_t next = 0, gets = 0, deletes = 0, borrowedDeletes = 0;
    size_t initializes = 0, sessions = 0, queries = 0, writes = 0, flushes = 0;
    bool appError = false, sessionError = false, deleteFault = false;
    bool opCloseFault = false, sessionCloseFault = false, appCloseFault = false;
    bool prefixWrite = false, flushFault = false;
    MI_Result appResult = MI_RESULT_OK, sessionResult = MI_RESULT_OK;
    std::wstring query;
    std::string output, closes;
};
static State s;
static MI_Result initialize(MI_Uint32, const MI_Char*, MI_Instance** error, MI_Application*) {
    ++s.initializes;
    *error = s.appError ? &s.owned : nullptr;
    return s.appResult;
}
static MI_Result newSession(MI_Application*, const MI_Char*, const MI_Char*,
                            const MI_DestinationOptions*, const MI_SessionCallbacks*,
                            MI_Instance** error, MI_Session*) {
    ++s.sessions;
    *error = s.sessionError ? &s.owned : nullptr;
    return s.sessionResult;
}
static void query(MI_Session*, MI_Uint32, const MI_OperationOptions*, const MI_Char*,
                  const MI_Char*, const MI_Char* text, const MI_OperationCallbacks*, MI_Operation*) {
    ++s.queries;
    s.query = text;
}
static MI_Result get(MI_Operation*, const MI_Instance** instance, MI_Boolean* more,
                     MI_Result* result, const MI_Char** message, const MI_Instance** details) {
    ++s.gets;
    // Every retrieval destroys/reuses the preceding borrowed values, including completion.
    s.borrowed = Row{};
    s.borrowed.exe = L"INVALIDATED";
    s.borrowed.cmd = L"INVALIDATED";
    *message = MI_T("borrowed completion");
    *details = &s.details;
    *instance = nullptr;
    *result = MI_RESULT_OK;
    *more = MI_FALSE;
    if (s.next == s.records.size()) return MI_RESULT_OK;
    const Record& record = s.records[s.next++];
    s.borrowed = record.row;
    if (record.instance) *instance = &s.instance;
    *result = record.operation;
    *more = s.next < s.records.size() ? MI_TRUE : MI_FALSE;
    return record.retrieval;
}
static MI_Result element(const MI_Instance* instance, const MI_Char* name, MI_Value* value,
                         MI_Type* type, MI_Uint32* flags, MI_Uint32*) {
    if (instance != &s.instance) return MI_RESULT_FAILED;
    const Row& row = s.borrowed;
    *flags = 0;
    if (!wcscmp(name, MI_T("ProcessId"))) {
        if (row.missingPid) return MI_RESULT_FAILED;
        *type = row.pidType; *flags = row.pidNull ? MI_FLAG_NULL : 0; value->uint32 = row.pid;
    } else if (!wcscmp(name, MI_T("CreationDate"))) {
        // Controlled exception at an actual copyRow call, inside the owner's protected region.
        if (row.copyFault) throw std::bad_alloc();
        if (row.missingDate) return MI_RESULT_FAILED;
        *type = row.dateType; *flags = row.dateNull ? MI_FLAG_NULL : 0;
        value->datetime = {};
        value->datetime.isTimestamp = row.timestamp ? MI_TRUE : MI_FALSE;
        value->datetime.u.timestamp.year = 2024;
        value->datetime.u.timestamp.month = 2;
        value->datetime.u.timestamp.day = 29;
    } else if (!wcscmp(name, MI_T("ExecutablePath"))) {
        *type = row.exeType; *flags = row.exeNull ? MI_FLAG_NULL : 0;
        value->string = const_cast<MI_Char*>(row.exe.c_str());
    } else if (!wcscmp(name, MI_T("CommandLine"))) {
        *type = row.cmdType; *flags = row.cmdNull ? MI_FLAG_NULL : 0;
        value->string = const_cast<MI_Char*>(row.cmd.c_str());
    } else return MI_RESULT_FAILED;
    return MI_RESULT_OK;
}
static MI_Result destroy(MI_Instance* instance) {
    if (instance != &s.owned) ++s.borrowedDeletes;
    else ++s.deletes;
    return s.deleteFault ? MI_RESULT_FAILED : MI_RESULT_OK;
}
static MI_Result closeOperation(MI_Operation*) {
    s.closes += 'O'; return s.opCloseFault ? MI_RESULT_FAILED : MI_RESULT_OK;
}
static MI_Result closeSession(MI_Session*, void*, void*) {
    s.closes += 'S'; return s.sessionCloseFault ? MI_RESULT_FAILED : MI_RESULT_OK;
}
static MI_Result closeApplication(MI_Application*) {
    s.closes += 'A'; return s.appCloseFault ? MI_RESULT_FAILED : MI_RESULT_OK;
}
static size_t write(const void* bytes, size_t size, size_t count, FILE*) {
    ++s.writes;
    const size_t accepted = s.prefixWrite && count ? count - 1 : count;
    s.output.append(static_cast<const char*>(bytes), size * accepted);
    return accepted;
}
static int flush(FILE*) { ++s.flushes; return s.flushFault ? EOF : 0; }
static int print(const char* format, ...) {
    char text[256];
    va_list args;
    va_start(args, format);
    const int length = vsnprintf(text, sizeof(text), format, args);
    va_end(args);
    if (length > 0 && static_cast<size_t>(length) < sizeof(text)) s.output.append(text, length);
    return length;
}
}

#define wmain producerMain
// Some SDK versions expose Initialize as a version-selection macro.
#undef MI_Application_Initialize
#define MI_Application_Initialize fixture::initialize
#define MI_Application_NewSession fixture::newSession
#define MI_Session_QueryInstances fixture::query
#define MI_Operation_GetInstance fixture::get
#define MI_Instance_GetElement fixture::element
#define MI_Instance_Delete fixture::destroy
#define MI_Operation_Close fixture::closeOperation
#define MI_Session_Close fixture::closeSession
#define MI_Application_Close fixture::closeApplication
#define fwrite fixture::write
#define fflush fixture::flush
#define printf fixture::print
#include "../../native/windows-mi/windows-mi.cpp"
#undef wmain
#undef MI_Application_Initialize
#undef MI_Application_NewSession
#undef MI_Session_QueryInstances
#undef MI_Operation_GetInstance
#undef MI_Instance_GetElement
#undef MI_Instance_Delete
#undef MI_Operation_Close
#undef MI_Session_Close
#undef MI_Application_Close
#undef fwrite
#undef fflush
#undef printf

namespace fixture {
static size_t assertions = 0, failures = 0, groups = 0;
static void check(bool value) { ++assertions; if (!value) ++failures; }
static void group(const char* name, size_t before) {
    ++groups;
    std::printf("{\"group\":\"%s\",\"failures\":%zu}\n", name, failures - before);
}
static void reset() { s = State{}; }
static int run(std::vector<std::wstring> args = { L"fixture", L"scalar", L"1" }) {
    std::vector<wchar_t*> argv;
    for (auto& arg : args) argv.push_back(arg.data());
    return producerMain(static_cast<int>(argv.size()), argv.data());
}
static std::vector<std::wstring> shared(size_t count) {
    std::vector<std::wstring> args = { L"fixture", L"shared" };
    for (size_t i = 1; i <= count; ++i) args.push_back(std::to_wstring(i));
    return args;
}
static void status(const char* name) {
    check(s.output == std::string("{\"schema\":\"native-mi-v1\",\"status\":\"") + name + "\"}\n");
    check(s.writes == 0 && s.flushes == 0);
}
static void drained(size_t count) {
    check(s.gets == count && s.next == s.records.size());
    check(s.closes == "OSA" && s.borrowedDeletes == 0);
}
static Record record(MI_Uint32 pid = 1) { Record r; r.row.pid = pid; return r; }
static void inputs() {
    const size_t before = failures;
    for (size_t count : { size_t(1), size_t(64) }) {
        reset(); check(run(shared(count)) == 0);
        check(s.query.size() <= 4096 && s.query.find(L"SELECT ProcessId,") == 0);
        check(std::all_of(s.query.begin(), s.query.end(), [](wchar_t c) { return c > 0 && c < 128; }));
    }
    for (const auto& args : std::vector<std::vector<std::wstring>>{
        shared(0), shared(65), {L"fixture", L"scalar", L"1", L"2"},
        {L"fixture", L"shared", L"1", L"1"}, {L"fixture", L"other", L"1"}, {L"fixture"} }) {
        reset(); check(run(args) == 1); status("input"); check(s.initializes == 0);
    }
    for (const wchar_t* invalid : { L"", L"0", L"01", L"-1", L"+1", L"1.0", L"1 OR 1=1", L" 1", L"9007199254740992" }) {
        reset(); check(run({L"fixture", L"scalar", invalid}) == 1); status("input"); check(s.initializes == 0);
    }
    reset(); check(run({L"fixture", L"scalar", L"9007199254740991"}) == 0);
    check(s.query == L"SELECT CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE ProcessId = 9007199254740991");
    auto maximum = shared(64);
    for (size_t i = 2; i < maximum.size(); ++i) maximum[i] = std::to_wstring(MaxPid - i);
    reset(); check(run(maximum) == 0); check(s.query.size() <= 4096);
    group("input-query-profile", before);
}
static void escaping() {
    const size_t before = failures;
    const MI_Char witness[] = { 0x22, 0x5c, 1, 0x0a, 0xd83d, 0xde00, 0xd800, 0 };
    std::string out;
    check(quoted(witness, out));
    check(out == "\"\\u0022\\u005c\\u0001\\u000a\\ud83d\\ude00\\ud800\"");
    check(out.size() == 2 + 7 * 6);
    const MI_Char loneLow[] = { 0xdfff, 0 };
    out.clear(); check(quoted(loneLow, out) && out == "\"\\udfff\"");
    out.clear(); check(!quoted(nullptr, out));
    out.clear(); check(quoted(MI_T(""), out) && out == "\"\"");
    group("actual-utf16-escape", before);
}
static void rows() {
    const size_t before = failures;
    for (int fault = 0; fault < 10; ++fault) {
        reset(); auto r = record();
        switch (fault) {
        case 0: r.row.missingPid = true; break;
        case 1: r.row.pidType = MI_STRING; break;
        case 2: r.row.pidNull = true; break;
        case 3: r.row.missingDate = true; break;
        case 4: r.row.dateType = MI_STRING; break;
        case 5: r.row.dateNull = true; break;
        case 6: r.row.timestamp = false; break;
        case 7: r.row.exeType = MI_UINT32; break;
        case 8: r.row.cmdType = MI_UINT32; break;
        case 9: r.row.pid = 3; break;
        }
        s.records = { r, record(2) };
        check(run(shared(2)) == 1); status("representation"); drained(2);
    }
    reset(); auto r = record(); r.row.missingPid = true; r.row.exeNull = r.row.cmdNull = true;
    s.records = {r}; check(run() == 0);
    check(s.output.find("\"exe\":null,\"cmd\":null") != std::string::npos); drained(1);
    reset(); r.row.exeType = MI_UINT32; s.records = {r};
    check(run() == 1); status("representation");
    reset(); s.records = {record(2), record(1)}; check(run(shared(2)) == 0);
    check(s.output.find("\"pid\":2") < s.output.find("\"pid\":1")); drained(2);
    reset(); s.records = {record(1), record(1), record(2)};
    check(run(shared(2)) == 1); status("representation"); drained(3);
    reset(); s.records = {record(), record()}; check(run() == 1); status("representation"); drained(2);
    reset(); check(run(shared(2)) == 0); check(s.output.find("\"rows\":[]") != std::string::npos);
    reset(); auto first = record(1), second = record(2);
    first.row.cmd = L"A"; second.row.cmd = L"B";
    Record completion; completion.instance = false;
    s.records = { first, second, completion }; check(run(shared(2)) == 0); drained(3);
    check(s.output.find("\\u0041") != std::string::npos && s.output.find("\\u0042") != std::string::npos);
    check(s.output.find("INVALIDATED") == std::string::npos);
    group("types-correlation-borrowed-copy", before);
}
static void bounds() {
    const size_t before = failures;
    reset();
    std::set<uint64_t> seen;
    std::string base, other;
    auto large = record(1), small = record(2);
    large.row.cmd.clear();
    s.borrowed = large.row;
    check(copyRow(&s.instance, true, {1, 2}, seen, base));
    s.borrowed = small.row;
    check(copyRow(&s.instance, true, {1, 2}, seen, other));
    // Actual copyRow determines fixed row bytes; no duplicate serializer or encoder oracle.
    const size_t units = (MaxOutput - 256 - base.size() - other.size()) / 6;
    large.row.cmd.assign(units, L'x');
    reset(); s.records = {large, small}; check(run(shared(2)) == 0); drained(2);
    check(s.output.size() <= MaxOutput && s.output.back() == '\n');
    // Cross the conservative row-aggregation reserve, not an invented exact MaxOutput acceptance.
    large.row.cmd.append(1, L'x');
    reset(); s.records = {large, small, record(3)};
    check(run(shared(3)) == 1); status("representation"); drained(3);
    reset();
    for (MI_Uint32 i = 1; i <= 64; ++i) {
        auto r = record(i); r.row.cmd.assign(32767, L'x'); s.records.push_back(std::move(r));
    }
    check(MaxOutput == 1024ULL * 1024 && 64ULL * 32767 * 6 > MaxOutput);
    check(run(shared(64)) == 1); status("representation"); drained(64);
    std::wstring tooLarge(MaxOutput / 6 + 1, L'x');
    std::string out;
    check(!quoted(tooLarge.c_str(), out) && out.size() <= MaxOutput);
    group("whole-response-reserve-and-64-long-commands", before);
}
static void draining() {
    const size_t before = failures;
    for (int fault = 0; fault < 5; ++fault) {
        reset(); auto r = record();
        const char* expected = "representation";
        if (fault == 0) { r.retrieval = MI_RESULT_FAILED; expected = "retrieval"; }
        if (fault == 1) { r.operation = MI_RESULT_FAILED; expected = "operation"; }
        if (fault == 2) r.row.dateNull = true;
        if (fault == 3) r.row.copyFault = true;
        if (fault == 4) r.row.cmd.assign(MaxOutput / 6 + 1, L'x');
        s.records = {r, record(2), record(3)};
        s.opCloseFault = s.sessionCloseFault = s.appCloseFault = true;
        check(run(shared(3)) == 1); status(expected); drained(3);
    }
    reset(); auto r = record(); r.retrieval = MI_RESULT_FAILED; r.operation = MI_RESULT_FAILED;
    s.records = {r, record(2)}; check(run(shared(2)) == 1); status("retrieval"); drained(2);
    reset(); r = record(); r.operation = MI_RESULT_FAILED; r.row.dateNull = true;
    s.records = {r}; check(run() == 1); status("operation"); drained(1);
    group("finite-drain-controlled-copy-bad-alloc-precedence", before);
}
static void resources() {
    const size_t before = failures;
    reset(); s.appResult = MI_RESULT_FAILED; s.appError = true; s.deleteFault = true;
    check(run() == 1); status("application"); check(s.deletes == 1 && s.closes.empty() && s.sessions == 0);
    reset(); s.sessionResult = MI_RESULT_FAILED; s.sessionError = true; s.appCloseFault = true;
    check(run() == 1); status("session"); check(s.deletes == 1 && s.closes == "A" && s.queries == 0);
    for (int fault = 0; fault < 4; ++fault) {
        reset(); s.appError = s.sessionError = true; s.records = {record()};
        if (fault == 0) s.deleteFault = true;
        if (fault == 1) s.opCloseFault = true;
        if (fault == 2) s.sessionCloseFault = true;
        if (fault == 3) s.appCloseFault = true;
        check(run() == 1); status("cleanup"); drained(1); check(s.deletes == 2);
    }
    reset(); s.appError = s.sessionError = true; check(run() == 0); check(s.deletes == 2); drained(1);
    group("owned-errors-and-close-attempts-not-physical-cleanup", before);
}
static void output() {
    const size_t before = failures;
    reset(); s.records = {record()}; check(run() == 0);
    const std::string complete = s.output;
    check(s.writes == 1 && s.flushes == 1 && complete.size() <= MaxOutput); drained(1);
    reset(); s.records = {record()}; s.prefixWrite = true;
    check(run() == 1); check(s.output == complete.substr(0, complete.size() - 1));
    check(s.writes == 1 && s.flushes == 0); drained(1);
    reset(); s.records = {record()}; s.flushFault = true;
    check(run() == 1); check(s.output == complete && s.writes == 1 && s.flushes == 1); drained(1);
    group("full-prefix-write-and-flush-failure-not-identity", before);
}
}
int main() {
    fixture::inputs();
    fixture::escaping();
    fixture::rows();
    fixture::bounds();
    fixture::draining();
    fixture::resources();
    fixture::output();
    std::printf("{\"schema\":\"native-mi-producer-properties-v1\",\"scope\":\"actual-producer-synthetic-MI-ports\",\"groups\":%zu,\"assertions\":%zu,\"failures\":%zu,\"faults\":\"controlled-not-provider-permission-or-real-OOM\",\"cleanup\":\"attempt-counters-not-native-resource-parity\"}\n",
        fixture::groups, fixture::assertions, fixture::failures);
    return fixture::failures ? 1 : 0;
}
