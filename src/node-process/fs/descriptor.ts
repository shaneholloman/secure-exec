// FileDescriptor - tracks open file handles
import { O_RDONLY, O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } from "./constants.js";

export class FileDescriptor {
  readonly fd: number;
  readonly path: string;
  readonly flags: number;
  private position: number;
  private closed: boolean;

  constructor(fd: number, path: string, flags: number) {
    this.fd = fd;
    this.path = path;
    this.flags = flags;
    this.position = 0;
    this.closed = false;
  }

  getPosition(): number {
    return this.position;
  }

  setPosition(pos: number): void {
    this.position = pos;
  }

  advancePosition(bytes: number): void {
    this.position += bytes;
  }

  isReadable(): boolean {
    const accessMode = this.flags & 3; // O_RDONLY=0, O_WRONLY=1, O_RDWR=2
    return accessMode === O_RDONLY || accessMode === O_RDWR;
  }

  isWritable(): boolean {
    const accessMode = this.flags & 3;
    return accessMode === O_WRONLY || accessMode === O_RDWR;
  }

  isAppend(): boolean {
    return (this.flags & O_APPEND) !== 0;
  }

  shouldCreate(): boolean {
    return (this.flags & O_CREAT) !== 0;
  }

  shouldTruncate(): boolean {
    return (this.flags & O_TRUNC) !== 0;
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
  }
}

// Manages file descriptors
export class FileDescriptorTable {
  private descriptors: Map<number, FileDescriptor> = new Map();
  private nextFd: number = 3; // 0, 1, 2 are stdin, stdout, stderr

  open(path: string, flags: number): number {
    const fd = this.nextFd++;
    this.descriptors.set(fd, new FileDescriptor(fd, path, flags));
    return fd;
  }

  get(fd: number): FileDescriptor | undefined {
    return this.descriptors.get(fd);
  }

  close(fd: number): boolean {
    const descriptor = this.descriptors.get(fd);
    if (descriptor) {
      descriptor.close();
      this.descriptors.delete(fd);
      return true;
    }
    return false;
  }

  isOpen(fd: number): boolean {
    const descriptor = this.descriptors.get(fd);
    return descriptor !== undefined && !descriptor.isClosed();
  }
}
