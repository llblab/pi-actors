/* Owns: pilot-A byte transport, retry budget and transport diagnostics.
 * Excludes: driver lifecycle, private Darwin ABI, containment and scope authority.
 * Internal test fixture: driver and syscall-shim unit compile this exact core.
 */
#ifndef PI_ACTORS_SPI_TRANSPORT_H
#define PI_ACTORS_SPI_TRANSPORT_H
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
#define WATCHDOG_MS 30000
static const char *role = "D";
static bool io_ok = true;
static int64_t now_ms(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
  return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static void pause_ms(void) { (void)poll(NULL, 0, 10); }
struct transport_error { const char *stage; int error; size_t written, requested; };
static struct transport_error first_transport;
/* Independent best-effort stderr, never emit()/the failing stdout lock. Retain
 * the first cause in every later diagnostic; stderr failure cannot replace it. */
static void transport_failure(const char *stage, int error, size_t written, size_t requested) {
  if (!first_transport.stage) first_transport = (struct transport_error){ stage, error, written, requested };
  io_ok = false;
  char data[512];
  int n = snprintf(data, sizeof(data),
    "{\"event\":\"transport_fault\",\"role\":\"%s\",\"pid\":%d,\"stage\":\"%s\",\"error\":%d,\"written\":%zu,\"requested\":%zu,"
    "\"first_stage\":\"%s\",\"first_error\":%d,\"first_written\":%zu,\"first_requested\":%zu}\n",
    role, (int)getpid(), stage, error, written, requested,
    first_transport.stage, first_transport.error, first_transport.written, first_transport.requested);
  if (n > 0 && (size_t)n < sizeof(data)) (void)write(STDERR_FILENO, data, (size_t)n);
  errno = error;
}
static bool retry_transport(const char *stage, int error, size_t written, size_t requested, int64_t end) {
  int64_t now = now_ms();
  int clock_error = errno;
  if (now < 0 || now >= end) {
    transport_failure(stage, error, written, requested);
    if (now < 0) transport_failure("clock", clock_error, written, requested);
    return false;
  }
  pause_ms();
  return true;
}
/* The fixture-local record lock serializes inherited stdout writers, including
 * on small PIPE_BUF systems. Once broken, stdout is never replayed/repaired. */
static bool emit(const char *format, ...) {
  if (!io_ok) return false;
  char data[4096];
  va_list ap;
  va_start(ap, format);
  int n = vsnprintf(data, sizeof(data), format, ap);
  int format_error = errno;
  va_end(ap);
  if (n < 0 || (size_t)n >= sizeof(data)) {
    transport_failure("format", n < 0 ? format_error : EOVERFLOW, 0, n < 0 ? 0 : (size_t)n); return false;
  }
  struct flock lock;
  memset(&lock, 0, sizeof(lock));
  lock.l_type = F_WRLCK; lock.l_whence = SEEK_SET; lock.l_len = 1;
  int64_t now = now_ms();
  if (now < 0) { int error = errno; transport_failure("clock", error, 0, (size_t)n); return false; }
  int64_t end = now + WATCHDOG_MS;
  while (fcntl(3, F_SETLK, &lock) == -1) {
    int lock_error = errno;
    if (lock_error != EACCES && lock_error != EAGAIN && lock_error != EINTR) {
      transport_failure("lock", lock_error, 0, (size_t)n); return false;
    }
    if (!retry_transport("lock", lock_error, 0, (size_t)n, end)) return false;
  }
  size_t at = 0;
  while (at < (size_t)n) {
    ssize_t put = write(STDOUT_FILENO, data + at, (size_t)n - at);
    int write_error = errno;
    if (put > 0) at += (size_t)put;
    else if (put < 0 && (write_error == EINTR || write_error == EAGAIN)) {
      if (!retry_transport("write", write_error, at, (size_t)n, end)) break;
    } else { transport_failure("write", put < 0 ? write_error : EIO, at, (size_t)n); break; }
  }
  lock.l_type = F_UNLCK;
  if (fcntl(3, F_SETLK, &lock)) { int unlock_error = errno; transport_failure("unlock", unlock_error, at, (size_t)n); }
  return io_ok;
}
#endif
