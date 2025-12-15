// Stats class implementing fs.Stats interface
import { S_IFDIR, S_IFREG, S_IFLNK, S_IFMT } from "./constants.js";

export interface StatsInit {
  dev?: number;
  ino?: number;
  mode: number;
  nlink?: number;
  uid?: number;
  gid?: number;
  rdev?: number;
  size: number;
  blksize?: number;
  blocks?: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  birthtimeMs?: number;
}

export class Stats {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;

  constructor(init: StatsInit) {
    const now = Date.now();

    this.dev = init.dev ?? 0;
    this.ino = init.ino ?? 0;
    this.mode = init.mode;
    this.nlink = init.nlink ?? 1;
    this.uid = init.uid ?? 0;
    this.gid = init.gid ?? 0;
    this.rdev = init.rdev ?? 0;
    this.size = init.size;
    this.blksize = init.blksize ?? 4096;
    this.blocks = init.blocks ?? Math.ceil(init.size / 512);
    this.atimeMs = init.atimeMs ?? now;
    this.mtimeMs = init.mtimeMs ?? now;
    this.ctimeMs = init.ctimeMs ?? now;
    this.birthtimeMs = init.birthtimeMs ?? now;
    this.atime = new Date(this.atimeMs);
    this.mtime = new Date(this.mtimeMs);
    this.ctime = new Date(this.ctimeMs);
    this.birthtime = new Date(this.birthtimeMs);
  }

  isFile(): boolean {
    return (this.mode & S_IFMT) === S_IFREG;
  }

  isDirectory(): boolean {
    return (this.mode & S_IFMT) === S_IFDIR;
  }

  isSymbolicLink(): boolean {
    return (this.mode & S_IFMT) === S_IFLNK;
  }

  isBlockDevice(): boolean {
    return false; // Not supported in virtual fs
  }

  isCharacterDevice(): boolean {
    return false; // Not supported in virtual fs
  }

  isFIFO(): boolean {
    return false; // Not supported in virtual fs
  }

  isSocket(): boolean {
    return false; // Not supported in virtual fs
  }

  // Create Stats for a regular file
  static forFile(size: number, times?: { mtime?: number }): Stats {
    return new Stats({
      mode: S_IFREG | 0o644,
      size,
      mtimeMs: times?.mtime,
    });
  }

  // Create Stats for a directory
  static forDirectory(): Stats {
    return new Stats({
      mode: S_IFDIR | 0o755,
      size: 4096,
    });
  }

  // Convert to a plain object for transfer across isolate boundary
  toJSON(): Record<string, unknown> {
    return {
      dev: this.dev,
      ino: this.ino,
      mode: this.mode,
      nlink: this.nlink,
      uid: this.uid,
      gid: this.gid,
      rdev: this.rdev,
      size: this.size,
      blksize: this.blksize,
      blocks: this.blocks,
      atimeMs: this.atimeMs,
      mtimeMs: this.mtimeMs,
      ctimeMs: this.ctimeMs,
      birthtimeMs: this.birthtimeMs,
    };
  }

  // Reconstruct Stats from plain object
  static fromJSON(obj: Record<string, unknown>): Stats {
    return new Stats({
      dev: obj.dev as number,
      ino: obj.ino as number,
      mode: obj.mode as number,
      nlink: obj.nlink as number,
      uid: obj.uid as number,
      gid: obj.gid as number,
      rdev: obj.rdev as number,
      size: obj.size as number,
      blksize: obj.blksize as number,
      blocks: obj.blocks as number,
      atimeMs: obj.atimeMs as number,
      mtimeMs: obj.mtimeMs as number,
      ctimeMs: obj.ctimeMs as number,
      birthtimeMs: obj.birthtimeMs as number,
    });
  }
}
