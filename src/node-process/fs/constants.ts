// fs.constants - file system flags and mode constants

// File access flags (O_* constants)
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_CREAT = 64;
export const O_EXCL = 128;
export const O_TRUNC = 512;
export const O_APPEND = 1024;

// File type bits (S_IF* constants)
export const S_IFMT = 61440; // File type mask
export const S_IFREG = 32768; // Regular file
export const S_IFDIR = 16384; // Directory
export const S_IFLNK = 40960; // Symbolic link
export const S_IFBLK = 24576; // Block device
export const S_IFCHR = 8192; // Character device
export const S_IFIFO = 4096; // FIFO
export const S_IFSOCK = 49152; // Socket

// File permission bits
export const S_IRWXU = 448; // Owner read/write/execute
export const S_IRUSR = 256; // Owner read
export const S_IWUSR = 128; // Owner write
export const S_IXUSR = 64; // Owner execute
export const S_IRWXG = 56; // Group read/write/execute
export const S_IRGRP = 32; // Group read
export const S_IWGRP = 16; // Group write
export const S_IXGRP = 8; // Group execute
export const S_IRWXO = 7; // Others read/write/execute
export const S_IROTH = 4; // Others read
export const S_IWOTH = 2; // Others write
export const S_IXOTH = 1; // Others execute

export const constants = {
  O_RDONLY,
  O_WRONLY,
  O_RDWR,
  O_CREAT,
  O_EXCL,
  O_TRUNC,
  O_APPEND,
  S_IFMT,
  S_IFREG,
  S_IFDIR,
  S_IFLNK,
  S_IFBLK,
  S_IFCHR,
  S_IFIFO,
  S_IFSOCK,
  S_IRWXU,
  S_IRUSR,
  S_IWUSR,
  S_IXUSR,
  S_IRWXG,
  S_IRGRP,
  S_IWGRP,
  S_IXGRP,
  S_IRWXO,
  S_IROTH,
  S_IWOTH,
  S_IXOTH,
};

// Parse flag string to numeric flags
export function parseFlags(flags: string | number): number {
  if (typeof flags === "number") return flags;

  switch (flags) {
    case "r":
      return O_RDONLY;
    case "r+":
      return O_RDWR;
    case "w":
      return O_WRONLY | O_CREAT | O_TRUNC;
    case "w+":
      return O_RDWR | O_CREAT | O_TRUNC;
    case "a":
      return O_WRONLY | O_CREAT | O_APPEND;
    case "a+":
      return O_RDWR | O_CREAT | O_APPEND;
    case "wx":
    case "xw":
      return O_WRONLY | O_CREAT | O_EXCL;
    case "wx+":
    case "xw+":
      return O_RDWR | O_CREAT | O_EXCL;
    case "ax":
    case "xa":
      return O_WRONLY | O_CREAT | O_APPEND | O_EXCL;
    case "ax+":
    case "xa+":
      return O_RDWR | O_CREAT | O_APPEND | O_EXCL;
    default:
      throw new Error(`Unknown file flag: ${flags}`);
  }
}
