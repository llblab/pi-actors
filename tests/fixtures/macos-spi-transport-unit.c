/* Host C-unit only: no driver, Darwin API, real core syscalls or scope proof.
 * The test reporter uses ordinary libc stdout/stderr outside the shimmed core.
 */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#define CAP 128
#define ALL (-2)
enum operation { CLOCK, LOCK, UNLOCK, OUT, ERR, PAUSE, PID };
struct step { enum operation op; ssize_t result; int error; int64_t ms; };
struct call {
  enum operation op;
  ssize_t result;
  int error, entered_errno, fd, command;
  struct flock lock;
  clockid_t clock_id;
  int64_t clock_ms;
  nfds_t nfds;
  int timeout;
  bool null_fds;
  size_t size;
  unsigned char data[4096];
};
static const struct step *script;
static size_t script_count, cursor, call_count;
static struct call calls[CAP];
static unsigned char out_bytes[8192], err_bytes[8192];
static size_t out_size, err_size;
static int failures;
static const char *case_name;
static const char packet[] = "abcdef\n";
#define CHECK(test) do { if (!(test)) { failures++; fprintf(stderr, "FAIL %s:%d: %s\n", case_name, __LINE__, #test); } } while (0)
static struct step take(enum operation op, int entered_errno) {
  struct step s = { op, -1, EIO, 0 };
  if (cursor >= script_count) CHECK(false);
  else {
    struct step expected = script[cursor++];
    if (expected.op != op) CHECK(false); else s = expected;
  }
  if (call_count >= CAP) { CHECK(false); return s; }
  calls[call_count++] = (struct call){ .op = op, .result = s.result, .error = s.error, .entered_errno = entered_errno };
  return s;
}
static int fake_fcntl(int fd, int cmd, ...) {
  int entered = errno;
  va_list ap; va_start(ap, cmd);
  struct flock *lock = va_arg(ap, struct flock *);
  va_end(ap);
  CHECK(fd == 3 && cmd == F_SETLK && lock != NULL);
  CHECK(lock->l_whence == SEEK_SET && lock->l_start == 0 && lock->l_len == 1);
  CHECK(lock->l_type == F_WRLCK || lock->l_type == F_UNLCK);
  struct step s = take(lock->l_type == F_UNLCK ? UNLOCK : LOCK, entered);
  struct call *c = &calls[call_count - 1]; c->fd = fd; c->command = cmd; c->lock = *lock;
  errno = s.error;
  return (int)s.result;
}
static ssize_t fake_write(int fd, const void *data, size_t size) {
  int entered = errno;
  CHECK(fd == STDOUT_FILENO || fd == STDERR_FILENO);
  struct step s = take(fd == STDOUT_FILENO ? OUT : ERR, entered);
  if (!call_count || call_count > CAP || size > sizeof(calls[0].data)) { CHECK(false); errno = EIO; return -1; }
  struct call *c = &calls[call_count - 1];
  c->fd = fd; c->size = size; memcpy(c->data, data, size);
  ssize_t accepted = s.result == ALL ? (ssize_t)size : s.result;
  if (accepted > (ssize_t)size) { CHECK(false); accepted = -1; s.error = EIO; }
  c->result = accepted; c->error = s.error;
  if (accepted > 0) {
    unsigned char *bytes = fd == STDOUT_FILENO ? out_bytes : err_bytes;
    size_t *at = fd == STDOUT_FILENO ? &out_size : &err_size;
    if (*at + (size_t)accepted > sizeof(out_bytes)) { CHECK(false); errno = EIO; return -1; }
    memcpy(bytes + *at, data, (size_t)accepted); *at += (size_t)accepted;
  }
  errno = s.error;
  return accepted;
}
static int fake_clock_gettime(clockid_t id, struct timespec *time) {
  int entered = errno;
  CHECK(id == CLOCK_MONOTONIC && time != NULL);
  struct step s = take(CLOCK, entered);
  calls[call_count - 1].clock_id = id; calls[call_count - 1].clock_ms = s.ms;
  if (s.result == 0) {
    time->tv_sec = (time_t)(s.ms / 1000); time->tv_nsec = (long)(s.ms % 1000) * 1000000;
    errno = s.error; return 0;
  }
  CHECK(s.result == -1);
  errno = s.error;
  return -1;
}
static int fake_poll(struct pollfd *fds, nfds_t count, int timeout) {
  int entered = errno;
  CHECK(fds == NULL && count == 0 && timeout == 10);
  struct step s = take(PAUSE, entered);
  struct call *c = &calls[call_count - 1]; c->nfds = count; c->timeout = timeout; c->null_fds = fds == NULL;
  errno = s.error;
  return (int)s.result;
}
static pid_t fake_getpid(void) {
  struct step s = take(PID, errno);
  errno = s.error;
  return (pid_t)s.result;
}
/* Headers above are already parsed. Only the identical transport core sees
 * these bindings; no whole-driver include, symbol wrappers or copied algorithm. */
#define fcntl fake_fcntl
#define write fake_write
#define clock_gettime fake_clock_gettime
#define poll fake_poll
#define getpid fake_getpid
#include "macos-spi-transport.h"
#undef fcntl
#undef write
#undef clock_gettime
#undef poll
#undef getpid

#define T(ms) { CLOCK, 0, EDOM, (ms) }
#define TF(e) { CLOCK, -1, (e), 0 }
#define L(r,e) { LOCK, (r), (e), 0 }
#define U(r,e) { UNLOCK, (r), (e), 0 }
#define O(r,e) { OUT, (r), (e), 0 }
#define E(r,e) { ERR, (r), (e), 0 }
#define P { PAUSE, 0, ERANGE, 0 }
#define G { PID, 424242, EOVERFLOW, 0 }
#define COUNT(a) (sizeof(a) / sizeof((a)[0]))
struct test_case {
  const char *name;
  const struct step *steps;
  size_t count;
  bool success, overflow;
  const char *output, *first_stage;
  int first_error;
  size_t first_written;
};
static void hex(const unsigned char *bytes, size_t n) {
  for (size_t i = 0; i < n; i++) printf("%02x", (unsigned)bytes[i]);
}
static void report(bool ok, bool result) {
  static const char *names[] = { "clock", "lock", "unlock", "stdout", "stderr", "poll", "getpid" };
  printf("{\"case\":\"%s\",\"evidence_mode\":\"simulated_syscalls\",\"ok\":%s,\"result\":%s,\"transport_ok\":%s,\"stdout_hex\":\"", case_name, ok ? "true" : "false", result ? "true" : "false", io_ok ? "true" : "false");
  hex(out_bytes, out_size); printf("\",\"stderr_hex\":\""); hex(err_bytes, err_size);
  printf("\",\"first\":");
  if (!first_transport.stage) printf("null");
  else printf("{\"stage\":\"%s\",\"error\":%d,\"written\":%zu,\"requested\":%zu}", first_transport.stage, first_transport.error, first_transport.written, first_transport.requested);
  printf(",\"calls\":[");
  for (size_t i = 0; i < call_count; i++) {
    const struct call *c = &calls[i];
    printf("%s{\"op\":\"%s\",\"result\":%zd,\"errno\":%d,\"entered_errno\":%d,\"requested_hex\":\"", i ? "," : "", names[c->op], c->result, c->error, c->entered_errno);
    hex(c->data, c->size); printf("\",\"delivered_hex\":\"");
    if ((c->op == OUT || c->op == ERR) && c->result > 0) hex(c->data, (size_t)c->result);
    printf("\"");
    if (c->op == OUT || c->op == ERR) printf(",\"fd\":%d", c->fd);
    if (c->op == LOCK || c->op == UNLOCK) printf(",\"fd\":%d,\"command\":%d,\"type\":%d,\"whence\":%d,\"start\":%lld,\"length\":%lld", c->fd, c->command, c->lock.l_type, c->lock.l_whence, (long long)c->lock.l_start, (long long)c->lock.l_len);
    if (c->op == CLOCK) {
      printf(",\"clock_id\":%d,\"clock_ms\":", (int)c->clock_id);
      if (c->result == 0) printf("%lld", (long long)c->clock_ms); else printf("null");
    }
    if (c->op == PAUSE) printf(",\"nfds\":%lu,\"timeout\":%d,\"null_fds\":%s", (unsigned long)c->nfds, c->timeout, c->null_fds ? "true" : "false");
    printf("}");
  }
  printf("]}\n");
}
static void run_case(struct test_case c) {
  case_name = c.name; script = c.steps; script_count = c.count; cursor = call_count = out_size = err_size = 0;
  memset(calls, 0, sizeof(calls)); first_transport = (struct transport_error){0}; io_ok = true; role = "D"; errno = 0;
  int before = failures;
  bool result = c.overflow ? emit("%04096d", 0) : emit("%s", packet);
  CHECK(result == c.success && io_ok == c.success);
  CHECK(cursor == script_count && call_count == script_count);
  const char *expected = c.output ? c.output : "";
  CHECK(out_size == strlen(expected) && memcmp(out_bytes, expected, out_size) == 0);
  if (c.first_stage) {
    CHECK(first_transport.stage && strcmp(first_transport.stage, c.first_stage) == 0);
    CHECK(first_transport.error == c.first_error && first_transport.written == c.first_written);
    CHECK(first_transport.requested == (c.overflow ? 4096 : strlen(packet)));
    size_t after = call_count;
    CHECK(!emit("must not repair stdout")); CHECK(call_count == after);
  } else CHECK(first_transport.stage == NULL);
  /* Each stdout request must start at the first undelivered byte, including
   * transient retries. Diagnostic requests and accepted bytes remain distinct. */
  size_t delivered = 0;
  for (size_t i = 0; i < call_count; i++) if (calls[i].op == OUT) {
    if (delivered > strlen(packet) || calls[i].size > strlen(packet) - delivered) { CHECK(false); break; }
    CHECK(calls[i].size == strlen(packet) - delivered);
    CHECK(memcmp(calls[i].data, packet + delivered, calls[i].size) == 0);
    if (calls[i].result > 0) delivered += (size_t)calls[i].result;
  }
  CHECK(delivered == out_size);
  report(before == failures, result);
}
int main(void) {
  const struct step full[] = { T(0), L(0, EDOM), O(ALL, ERANGE), U(0, EDOM) };
  run_case((struct test_case){ .name="full", .steps=full, .count=COUNT(full), .success=true, .output=packet });
  const struct step short_ok[] = { T(0), L(0,0), O(2,EDOM), O(3,ERANGE), O(2,EDOM), U(0,0) };
  run_case((struct test_case){ .name="short-success", .steps=short_ok, .count=COUNT(short_ok), .success=true, .output=packet });
  const struct step write_retry[] = { T(0), L(0,0), O(2,0), O(-1,EINTR), T(1), P, O(-1,EAGAIN), T(2), P, O(ALL,0), U(0,0) };
  run_case((struct test_case){ .name="write-retry", .steps=write_retry, .count=COUNT(write_retry), .success=true, .output=packet });
  const struct step lock_retry[] = { T(0), L(-1,EINTR), T(1), P, L(-1,EAGAIN), T(2), P, L(0,0), O(ALL,0), U(0,0) };
  run_case((struct test_case){ .name="lock-retry", .steps=lock_retry, .count=COUNT(lock_retry), .success=true, .output=packet });
  const struct step lock_hard[] = { T(0), L(-1,ENOLCK), G, E(ALL,0) };
  run_case((struct test_case){ .name="lock-hard", .steps=lock_hard, .count=COUNT(lock_hard), .first_stage="lock", .first_error=ENOLCK });
  const struct step lock_budget[] = { T(0), L(-1,EACCES), T(WATCHDOG_MS), G, E(ALL,0) };
  run_case((struct test_case){ .name="lock-budget", .steps=lock_budget, .count=COUNT(lock_budget), .first_stage="lock", .first_error=EACCES });
  const struct step write_budget[] = { T(0), L(0,0), O(2,0), O(-1,EAGAIN), T(WATCHDOG_MS), G, E(ALL,0), U(0,EDOM) };
  run_case((struct test_case){ .name="write-budget", .steps=write_budget, .count=COUNT(write_budget), .output="ab", .first_stage="write", .first_error=EAGAIN, .first_written=2 });
  const struct step double_fault[] = { T(0), L(0,0), O(2,0), O(-1,EIO), G, E(ALL,EPIPE), U(-1,EBADF), G, E(ALL,ERANGE) };
  run_case((struct test_case){ .name="write-unlock", .steps=double_fault, .count=COUNT(double_fault), .output="ab", .first_stage="write", .first_error=EIO, .first_written=2 });
  const struct step zero[] = { T(0), L(0,0), O(0,0), G, E(ALL,0), U(0,0) };
  run_case((struct test_case){ .name="zero-write", .steps=zero, .count=COUNT(zero), .first_stage="write", .first_error=EIO });
  const struct step initial_clock[] = { TF(EPERM), G, E(ALL,0) };
  run_case((struct test_case){ .name="clock-initial", .steps=initial_clock, .count=COUNT(initial_clock), .first_stage="clock", .first_error=EPERM });
  const struct step write_clock[] = { T(0), L(0,0), O(-1,EAGAIN), TF(EFAULT), G, E(ALL,0), G, E(ALL,0), U(0,0) };
  run_case((struct test_case){ .name="clock-after-write", .steps=write_clock, .count=COUNT(write_clock), .first_stage="write", .first_error=EAGAIN });
  const struct step lock_clock[] = { T(0), L(-1,EAGAIN), TF(EFAULT), G, E(ALL,0), G, E(ALL,0) };
  run_case((struct test_case){ .name="clock-after-lock", .steps=lock_clock, .count=COUNT(lock_clock), .first_stage="lock", .first_error=EAGAIN });
  const struct step unlock[] = { T(0), L(0,0), O(ALL,0), U(-1,EINTR), G, E(ALL,0) };
  run_case((struct test_case){ .name="unlock-only", .steps=unlock, .count=COUNT(unlock), .output=packet, .first_stage="unlock", .first_error=EINTR, .first_written=7 });
  const int stderr_errors[] = { EAGAIN, EPIPE, EINTR };
  const char *names[] = { "stderr-eagain", "stderr-epipe", "stderr-eintr" };
  for (size_t i = 0; i < COUNT(stderr_errors); i++) {
    const struct step unavailable[] = { T(0), L(0,0), O(-1,EIO), G, E(-1,stderr_errors[i]), U(-1,EBADF), G, E(ALL,EDOM) };
    run_case((struct test_case){ .name=names[i], .steps=unavailable, .count=COUNT(unavailable), .first_stage="write", .first_error=EIO });
  }
  const struct step short_err[] = { T(0), L(0,0), O(-1,EIO), G, E(3,EAGAIN), U(-1,EBADF), G, E(ALL,0) };
  run_case((struct test_case){ .name="stderr-short", .steps=short_err, .count=COUNT(short_err), .first_stage="write", .first_error=EIO });
  const struct step no_err[] = { T(0), L(0,0), O(-1,EIO), G, E(-1,EPIPE), U(-1,EBADF), G, E(-1,EAGAIN) };
  run_case((struct test_case){ .name="stderr-unavailable", .steps=no_err, .count=COUNT(no_err), .first_stage="write", .first_error=EIO });
  const struct step overflow[] = { G, E(ALL,0) };
  run_case((struct test_case){ .name="format-overflow", .steps=overflow, .count=COUNT(overflow), .overflow=true, .first_stage="format", .first_error=EOVERFLOW });
  return failures ? 1 : 0;
}
