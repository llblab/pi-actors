/* Research-only pilot A. Never a Run backend or a scope-control capability.
 * Reviewed ABI facts: Apple XNU f6217f891ac0bb64f3d375211650a4c1ff8ca1ea,
 * bsd/sys/proc_info_private.h. No private header download/installation at runtime.
 * Linux may parse this translation unit, but cannot link/run the Darwin SPI.
 */
#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#ifdef __APPLE__
#include <libproc.h>
#define PILOT_DARWIN 1
#else
extern int proc_pidinfo(int, int, uint64_t, void *, int);
#define PILOT_DARWIN 0
#endif
#define ABI "f6217f891ac0bb64f3d375211650a4c1ff8ca1ea"
#define UNIQUE_FLAVOR 17
#define COALITION_FLAVOR 20
#define MAX_GROUPS 128
struct pilot_unique {
  uint8_t uuid[16];
  uint64_t uniqueid, parent_uniqueid;
  int32_t idversion, original_parent_version;
  uint64_t reserved[2];
};
struct pilot_coalition { uint64_t ids[2], reserved[3]; };
_Static_assert(sizeof(struct pilot_unique) == 56, "reviewed unique ABI");
_Static_assert(sizeof(struct pilot_coalition) == 40, "reviewed coalition ABI");
_Static_assert(offsetof(struct pilot_unique, uniqueid) == 16, "uniqueid offset");
_Static_assert(offsetof(struct pilot_unique, parent_uniqueid) == 24, "parent uniqueid offset");
_Static_assert(offsetof(struct pilot_unique, idversion) == 32, "version offset");
_Static_assert(offsetof(struct pilot_unique, original_parent_version) == 36, "parent version offset");
_Static_assert(offsetof(struct pilot_unique, reserved) == 40, "unique reserved offset");
_Static_assert(offsetof(struct pilot_coalition, reserved) == 16, "coalition reserved offset");
/* Reviewed coalition type mapping: RESOURCE=0, JETSAM=1; no inferred types. */
#include "macos-spi-transport.h"
static int64_t started;
static void fault(const char *stage, int error) {
  (void)emit("{\"event\":\"fault\",\"role\":\"%s\",\"pid\":%d,\"stage\":\"%s\",\"error\":%d}\n", role, (int)getpid(), stage, error);
}
static bool gate(int fd, char expected) {
  for (;;) {
    int64_t now = now_ms();
    if (now < 0 || now - started >= WATCHDOG_MS) { fault("deadline", ETIMEDOUT); return false; }
    struct pollfd p = { .fd = fd, .events = POLLIN | POLLHUP };
    int ready = poll(&p, 1, 50);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) { fault("gate", errno); return false; }
    if (!ready) continue;
    char value;
    ssize_t n = read(fd, &value, 1);
    if (n < 0 && errno == EINTR) continue;
    if (n != 1 || value != expected) { fault("gate", n < 0 ? errno : ECANCELED); return false; }
    return true;
  }
}
static bool command(int fd, char value) {
  ssize_t n;
  do { n = write(fd, &value, 1); } while (n < 0 && errno == EINTR);
  if (n != 1) { fault("gate", n < 0 ? errno : EIO); return false; }
  return true;
}
static bool observe(const char *phase, bool attempted, pid_t result, int session_errno) {
  struct pilot_unique u;
  struct pilot_coalition c;
  memset(&u, 0, sizeof(u)); memset(&c, 0, sizeof(c));
  errno = 0;
  int ur = proc_pidinfo(getpid(), UNIQUE_FLAVOR, 0, &u, sizeof(u));
  int ue = errno;
  errno = 0;
  int cr = proc_pidinfo(getpid(), COALITION_FLAVOR, 0, &c, sizeof(c));
  int ce = errno;
  gid_t groups[MAX_GROUPS];
  int ng = getgroups(MAX_GROUPS, groups);
  if (ng < 0) { fault("rights", errno); return false; }
  char group_text[1600], uuid[33];
  size_t pos = 0;
  for (int i = 0; i < ng; i++) {
    int n = snprintf(group_text + pos, sizeof(group_text) - pos, "%s%u", i ? "," : "", (unsigned)groups[i]);
    if (n < 0 || (size_t)n >= sizeof(group_text) - pos) { fault("transport", EOVERFLOW); return false; }
    pos += (size_t)n;
  }
  group_text[pos] = '\0';
  for (int i = 0; i < 16; i++) (void)snprintf(uuid + 2 * i, 3, "%02x", u.uuid[i]);
  char session_result[32];
  if (attempted) (void)snprintf(session_result, sizeof(session_result), "%d", (int)result);
  else (void)snprintf(session_result, sizeof(session_result), "null");
  return emit("{\"event\":\"observe\",\"role\":\"%s\",\"phase\":\"%s\",\"pid\":%d,\"ppid\":%d,\"pgid\":%d,\"sid\":%d,"
    "\"uid\":%u,\"euid\":%u,\"gid\":%u,\"egid\":%u,\"groups\":[%s],"
    "\"unique_return\":%d,\"unique_errno\":%d,\"coalition_return\":%d,\"coalition_errno\":%d,"
    "\"uuid\":\"%s\",\"uniqueid\":\"%" PRIu64 "\",\"parent_uniqueid\":\"%" PRIu64 "\",\"idversion\":%" PRId32 ",\"original_parent_version\":%" PRId32 ","
    "\"unique_reserved\":[\"%" PRIu64 "\",\"%" PRIu64 "\"],\"coalition_ids\":[\"%" PRIu64 "\",\"%" PRIu64 "\"],"
    "\"coalition_reserved\":[\"%" PRIu64 "\",\"%" PRIu64 "\",\"%" PRIu64 "\"],\"setsid_attempted\":%s,\"setsid_result\":%s,\"setsid_errno\":%d}\n",
    role, phase, (int)getpid(), (int)getppid(), (int)getpgid(0), (int)getsid(0),
    (unsigned)getuid(), (unsigned)geteuid(), (unsigned)getgid(), (unsigned)getegid(), group_text,
    ur, ue, cr, ce, uuid, u.uniqueid, u.parent_uniqueid, u.idversion, u.original_parent_version,
    u.reserved[0], u.reserved[1], c.ids[0], c.ids[1], c.reserved[0], c.reserved[1], c.reserved[2],
    attempted ? "true" : "false", session_result, session_errno);
}
static bool birth(const char *child_role, pid_t pid) {
  return emit("{\"event\":\"birth\",\"parent_role\":\"%s\",\"role\":\"%s\",\"parent_pid\":%d,\"pid\":%d}\n", role, child_role, (int)getpid(), (int)pid);
}
static bool reap(const char *child_role, pid_t pid) {
  int status = 0;
  int64_t end = now_ms() + WATCHDOG_MS + 8000;
  for (;;) {
    pid_t found = waitpid(pid, &status, WNOHANG);
    if (found == pid) break;
    if (found < 0 && errno != EINTR) { fault("waitpid", errno); return false; }
    if (now_ms() < 0 || now_ms() >= end) { fault("deadline", ETIMEDOUT); return false; }
    pause_ms();
  }
  const char *kind = WIFEXITED(status) ? "exit" : WIFSIGNALED(status) ? "signal" : "other";
  int value = WIFEXITED(status) ? WEXITSTATUS(status) : WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  bool sent = emit("{\"event\":\"wait\",\"parent_role\":\"%s\",\"role\":\"%s\",\"parent_pid\":%d,\"pid\":%d,\"kind\":\"%s\",\"value\":%d,\"raw_status\":%d}\n",
    role, child_role, (int)getpid(), (int)pid, kind, value, status);
  return sent && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}
static int leaf(int fd, const char *name) {
  role = name; started = now_ms();
  if (!gate(fd, 'I') || !observe("before", false, 0, 0) || !gate(fd, 'O')) return 125;
  bool change = strcmp(name, "A.leaf") == 0;
  errno = 0;
  pid_t result = change ? setsid() : 0;
  int error = change ? errno : 0;
  if (!observe("after", change, result, error) || !gate(fd, 'R')) return 125;
  return 0;
}
static int branch(int fd, const char *name, int inherited_other) {
  if (inherited_other >= 0) close(inherited_other);
  role = name; started = now_ms();
  if (!gate(fd, 'I') || !observe("ready", false, 0, 0) || !gate(fd, 'E')) return 125;
  const char *child_role = strcmp(name, "A") == 0 ? "A.leaf" : "B.leaf";
  int pipefd[2];
  if (pipe(pipefd)) { fault("pipe", errno); return 125; }
  pid_t child = fork();
  if (child == 0) {
    close(pipefd[1]); close(fd);
    _exit(leaf(pipefd[0], child_role));
  }
  if (child < 0) { int error = errno; close(pipefd[0]); close(pipefd[1]); fault("fork", error); return 125; }
  /* Capture this positive birth before any wait, readiness or SPI observation. */
  bool ok = birth(child_role, child);
  close(pipefd[0]);
  if (ok) ok = command(pipefd[1], 'I');
  if (ok) ok = gate(fd, 'O') && command(pipefd[1], 'O');
  if (ok) ok = gate(fd, 'R') && command(pipefd[1], 'R');
  close(pipefd[1]); close(fd);
  bool settled = reap(child_role, child);
  return ok && settled ? 0 : 125;
}
int main(int argc, char **argv) {
  if (!PILOT_DARWIN || argc != 2 || strcmp(argv[1], "--execute-readonly-pilot-a")) {
    (void)fprintf(stderr, "Research-only Darwin pilot A; explicit native execution admission required.\n"); return 2;
  }
  (void)signal(SIGPIPE, SIG_IGN);
  int err_flags = fcntl(STDERR_FILENO, F_GETFL);
  if (err_flags < 0 || fcntl(STDERR_FILENO, F_SETFL, err_flags | O_NONBLOCK)) {
    int error = errno; transport_failure("stderr_flags", error, 0, 0); return 2;
  }
  int flags = fcntl(STDOUT_FILENO, F_GETFL);
  if (flags < 0 || fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK)) {
    int error = errno; transport_failure("stdout_flags", error, 0, 0); return 2;
  }
  struct stat lock_info;
  if (fstat(3, &lock_info)) { int error = errno; transport_failure("lock_fd", error, 0, 0); return 2; }
  if (!S_ISREG(lock_info.st_mode)) { transport_failure("lock_fd", EINVAL, 0, 0); return 2; }
  started = now_ms();
  if (!emit("{\"event\":\"hello\",\"pid\":%d,\"abi\":\"%s\",\"unique_size\":56,\"coalition_size\":40,\"coalition_types\":2,\"watchdog_ms\":30000}\n", (int)getpid(), ABI)) return 2;
  if (getuid() == 0 || geteuid() == 0) { fault("rights", EPERM); return 2; }
  bool ok = observe("ready", false, 0, 0) && gate(STDIN_FILENO, 'S');
  pid_t children[2] = { -1, -1 };
  int writes[2] = { -1, -1 };
  const char *names[2] = { "A", "B" };
  for (int i = 0; ok && i < 2; i++) {
    int p[2];
    if (pipe(p)) { fault("pipe", errno); ok = false; break; }
    pid_t child = fork();
    if (child == 0) {
      close(p[1]); close(STDIN_FILENO);
      _exit(branch(p[0], names[i], i ? writes[0] : -1));
    }
    if (child < 0) { int error = errno; close(p[0]); close(p[1]); fault("fork", error); ok = false; break; }
    children[i] = child;
    ok = birth(names[i], child);
    close(p[0]); writes[i] = p[1];
    if (ok) ok = command(writes[i], 'I');
  }
  if (ok) ok = gate(STDIN_FILENO, 'E');
  for (int i = 0; ok && i < 2; i++) ok = command(writes[i], 'E');
  if (ok) ok = gate(STDIN_FILENO, 'O');
  for (int i = 0; ok && i < 2; i++) ok = command(writes[i], 'O');
  if (ok) ok = gate(STDIN_FILENO, 'R');
  for (int i = 0; ok && i < 2; i++) ok = command(writes[i], 'R');
  for (int i = 0; i < 2; i++) if (writes[i] >= 0) close(writes[i]);
  for (int i = 0; i < 2; i++) if (children[i] > 0) {
    bool settled = reap(names[i], children[i]);
    ok = settled && ok;
  }
  (void)emit("{\"event\":\"end\",\"pid\":%d,\"io_ok\":%s,\"complete\":%s}\n", (int)getpid(), io_ok ? "true" : "false", ok && io_ok ? "true" : "false");
  return ok && io_ok ? 0 : 2;
}
