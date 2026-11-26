STATUS: done
Summary: The 5s registration poll now stats the file and skips the read and decode when mtime, size and inode match the last successful ownership check.
A failed stat (deleted file) still falls through to the existing read path, so deletion and replacement are reported and shut down within 5s exactly as before.
Only the poll loop changed; takeover, ready write, and shutdown behavior are untouched.
Area: idle wakeups. packages/cli/src/services/service-registration.ts ~line 75-90 re-reads and parses the registration file every 5s.
Task: stat the file first and re-read only when mtime/size/inode changed since the last successful ownership check (still detect deletion/replacement within 5s). Only that file; no behavior change.
