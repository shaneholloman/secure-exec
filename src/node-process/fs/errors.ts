// Standard Node.js filesystem errors

export interface FsError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
}

const ERROR_CODES: Record<string, { errno: number; message: string }> = {
  ENOENT: { errno: -2, message: "no such file or directory" },
  EEXIST: { errno: -17, message: "file already exists" },
  EISDIR: { errno: -21, message: "illegal operation on a directory" },
  ENOTDIR: { errno: -20, message: "not a directory" },
  ENOTEMPTY: { errno: -39, message: "directory not empty" },
  EBADF: { errno: -9, message: "bad file descriptor" },
  EINVAL: { errno: -22, message: "invalid argument" },
  EACCES: { errno: -13, message: "permission denied" },
  EBUSY: { errno: -16, message: "resource busy or locked" },
  EMFILE: { errno: -24, message: "too many open files" },
  ENODEV: { errno: -19, message: "no such device" },
  ENOTTY: { errno: -25, message: "inappropriate ioctl for device" },
  EPERM: { errno: -1, message: "operation not permitted" },
  EROFS: { errno: -30, message: "read-only file system" },
};

export function createError(
  code: string,
  syscall: string,
  path?: string
): FsError {
  const info = ERROR_CODES[code] || { errno: -1, message: "unknown error" };
  const pathSuffix = path ? `, '${path}'` : "";
  const message = `${code}: ${info.message}${pathSuffix}`;

  const error = new Error(message) as FsError;
  error.code = code;
  error.errno = info.errno;
  error.syscall = syscall;
  if (path) error.path = path;

  return error;
}

// Convenience functions for common errors
export function ENOENT(syscall: string, path: string): FsError {
  return createError("ENOENT", syscall, path);
}

export function EEXIST(syscall: string, path: string): FsError {
  return createError("EEXIST", syscall, path);
}

export function EISDIR(syscall: string, path: string): FsError {
  return createError("EISDIR", syscall, path);
}

export function ENOTDIR(syscall: string, path: string): FsError {
  return createError("ENOTDIR", syscall, path);
}

export function ENOTEMPTY(syscall: string, path: string): FsError {
  return createError("ENOTEMPTY", syscall, path);
}

export function EBADF(syscall: string): FsError {
  return createError("EBADF", syscall);
}

export function EINVAL(syscall: string, path?: string): FsError {
  return createError("EINVAL", syscall, path);
}
