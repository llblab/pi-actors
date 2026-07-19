# Project Backlog

## Open Work

### Windows filesystem fencing verification

- [ ] Add Windows CI and native NTFS regressions for consolidation root identity, directory junction/reparse-point substitution, lifecycle locks, and recovery without requiring privileged symbolic-link creation. Keep bigint device/inode capture, document filesystems that report weak or zero file identity, and evaluate a native handle-relative mutation layer only if real Windows evidence justifies expanding beyond Node’s portable process-crash and trusted-state-tree contract.
