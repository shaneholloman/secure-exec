// fs polyfill module for isolated-vm
// This module provides the code to inject into the isolate and the host-side references

import { Stats } from "./stats.js";
import { constants, parseFlags, O_APPEND, O_CREAT, O_TRUNC } from "./constants.js";
import { ENOENT, EBADF, EISDIR, ENOTDIR, EINVAL } from "./errors.js";

export { Stats } from "./stats.js";
export { constants, parseFlags } from "./constants.js";
export * from "./errors.js";
export { FileDescriptor, FileDescriptorTable } from "./descriptor.js";

// The fs module code to inject into the isolate
// This code assumes _fs object is available with References to host functions
export const FS_MODULE_CODE = `
(function() {
  // File descriptor table
  const fdTable = new Map();
  let nextFd = 3;

  // Stats class
  class Stats {
    constructor(init) {
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
      this.atimeMs = init.atimeMs ?? Date.now();
      this.mtimeMs = init.mtimeMs ?? Date.now();
      this.ctimeMs = init.ctimeMs ?? Date.now();
      this.birthtimeMs = init.birthtimeMs ?? Date.now();
      this.atime = new Date(this.atimeMs);
      this.mtime = new Date(this.mtimeMs);
      this.ctime = new Date(this.ctimeMs);
      this.birthtime = new Date(this.birthtimeMs);
    }
    isFile() { return (this.mode & 61440) === 32768; }
    isDirectory() { return (this.mode & 61440) === 16384; }
    isSymbolicLink() { return (this.mode & 61440) === 40960; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
  }

  // Dirent class for readdir with withFileTypes
  class Dirent {
    constructor(name, isDir) {
      this.name = name;
      this._isDir = isDir;
    }
    isFile() { return !this._isDir; }
    isDirectory() { return this._isDir; }
    isSymbolicLink() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
  }

  // Parse flags string to number
  function parseFlags(flags) {
    if (typeof flags === 'number') return flags;
    const flagMap = {
      'r': 0, 'r+': 2, 'w': 577, 'w+': 578,
      'a': 1089, 'a+': 1090, 'wx': 705, 'xw': 705,
      'wx+': 706, 'xw+': 706, 'ax': 1217, 'xa': 1217,
      'ax+': 1218, 'xa+': 1218
    };
    if (flags in flagMap) return flagMap[flags];
    throw new Error('Unknown file flag: ' + flags);
  }

  // Check if flags allow reading
  function canRead(flags) {
    const mode = flags & 3;
    return mode === 0 || mode === 2;
  }

  // Check if flags allow writing
  function canWrite(flags) {
    const mode = flags & 3;
    return mode === 1 || mode === 2;
  }

  const fs = {
    // Constants
    constants: {
      O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
      O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024,
      S_IFMT: 61440, S_IFREG: 32768, S_IFDIR: 16384, S_IFLNK: 40960
    },

    Stats: Stats,
    Dirent: Dirent,

    // Sync methods

    readFileSync(path, options) {
      const encoding = typeof options === 'string' ? options : options?.encoding;
      const content = _fs.readFile.applySyncPromise(undefined, [String(path)]);
      if (encoding) return content;
      // Return Buffer if no encoding specified
      return Buffer.from(content);
    },

    writeFileSync(path, data, options) {
      const content = typeof data === 'string' ? data :
        (data instanceof Uint8Array ? new TextDecoder().decode(data) : String(data));
      _fs.writeFile.applySync(undefined, [String(path), content]);
    },

    appendFileSync(path, data, options) {
      const existing = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
      const content = typeof data === 'string' ? data : String(data);
      fs.writeFileSync(path, existing + content, options);
    },

    readdirSync(path, options) {
      const entriesJson = _fs.readDir.applySyncPromise(undefined, [String(path)]);
      const entries = JSON.parse(entriesJson);
      if (options?.withFileTypes) {
        return entries.map(e => new Dirent(e.name, e.isDirectory));
      }
      return entries.map(e => e.name);
    },

    mkdirSync(path, options) {
      const recursive = options?.recursive ?? false;
      _fs.mkdir.applySync(undefined, [String(path), recursive]);
    },

    rmdirSync(path) {
      _fs.rmdir.applySyncPromise(undefined, [String(path)]);
    },

    existsSync(path) {
      return _fs.exists.applySyncPromise(undefined, [String(path)]);
    },

    statSync(path) {
      const statJson = _fs.stat.applySyncPromise(undefined, [String(path)]);
      const stat = JSON.parse(statJson);
      return new Stats(stat);
    },

    lstatSync(path) {
      // In our virtual fs, lstat is the same as stat (no symlinks)
      return fs.statSync(path);
    },

    unlinkSync(path) {
      _fs.unlink.applySyncPromise(undefined, [String(path)]);
    },

    renameSync(oldPath, newPath) {
      _fs.rename.applySyncPromise(undefined, [String(oldPath), String(newPath)]);
    },

    copyFileSync(src, dest) {
      const content = fs.readFileSync(src);
      fs.writeFileSync(dest, content);
    },

    // File descriptor methods

    openSync(path, flags, mode) {
      const numFlags = parseFlags(flags);
      const fd = nextFd++;

      // Check if file exists
      const exists = fs.existsSync(path);

      // Handle O_CREAT - create file if it doesn't exist
      if ((numFlags & 64) && !exists) {
        fs.writeFileSync(path, '');
      } else if (!exists && !(numFlags & 64)) {
        const err = new Error("ENOENT: no such file or directory, open '" + path + "'");
        err.code = 'ENOENT';
        err.errno = -2;
        err.syscall = 'open';
        err.path = path;
        throw err;
      }

      // Handle O_TRUNC - truncate file
      if ((numFlags & 512) && exists) {
        fs.writeFileSync(path, '');
      }

      fdTable.set(fd, { path, flags: numFlags, position: 0 });
      return fd;
    },

    closeSync(fd) {
      if (!fdTable.has(fd)) {
        const err = new Error('EBADF: bad file descriptor, close');
        err.code = 'EBADF';
        err.errno = -9;
        err.syscall = 'close';
        throw err;
      }
      fdTable.delete(fd);
    },

    readSync(fd, buffer, offset, length, position) {
      const entry = fdTable.get(fd);
      if (!entry) {
        const err = new Error('EBADF: bad file descriptor, read');
        err.code = 'EBADF';
        err.errno = -9;
        err.syscall = 'read';
        throw err;
      }
      if (!canRead(entry.flags)) {
        const err = new Error('EBADF: bad file descriptor, read');
        err.code = 'EBADF';
        err.errno = -9;
        err.syscall = 'read';
        throw err;
      }

      const content = fs.readFileSync(entry.path, 'utf8');
      const readPos = position !== null && position !== undefined ? position : entry.position;
      const toRead = content.slice(readPos, readPos + length);
      const bytes = Buffer.from(toRead);

      for (let i = 0; i < bytes.length && i < length; i++) {
        buffer[offset + i] = bytes[i];
      }

      if (position === null || position === undefined) {
        entry.position += bytes.length;
      }

      return bytes.length;
    },

    writeSync(fd, buffer, offset, length, position) {
      const entry = fdTable.get(fd);
      if (!entry) {
        const err = new Error('EBADF: bad file descriptor, write');
        err.code = 'EBADF';
        err.errno = -9;
        err.syscall = 'write';
        throw err;
      }
      if (!canWrite(entry.flags)) {
        const err = new Error('EBADF: bad file descriptor, write');
        err.code = 'EBADF';
        err.errno = -9;
        err.syscall = 'write';
        throw err;
      }

      // Handle string or buffer
      let data;
      if (typeof buffer === 'string') {
        data = buffer;
        length = data.length;
      } else {
        const slice = buffer.slice(offset, offset + length);
        data = new TextDecoder().decode(slice);
      }

      // Read existing content
      let content = '';
      if (fs.existsSync(entry.path)) {
        content = fs.readFileSync(entry.path, 'utf8');
      }

      // Determine write position
      let writePos;
      if (entry.flags & 1024) { // O_APPEND
        writePos = content.length;
      } else if (position !== null && position !== undefined) {
        writePos = position;
      } else {
        writePos = entry.position;
      }

      // Pad with nulls if writing past end
      while (content.length < writePos) {
        content += '\\0';
      }

      // Write data
      const newContent = content.slice(0, writePos) + data + content.slice(writePos + data.length);
      fs.writeFileSync(entry.path, newContent);

      // Update position if not using explicit position
      if (position === null || position === undefined) {
        entry.position = writePos + data.length;
      }

      return data.length;
    },

    fstatSync(fd) {
      const entry = fdTable.get(fd);
      if (!entry) {
        const err = new Error('EBADF: bad file descriptor, fstat');
        err.code = 'EBADF';
        err.errno = -9;
        err.syscall = 'fstat';
        throw err;
      }
      return fs.statSync(entry.path);
    },

    ftruncateSync(fd, len) {
      const entry = fdTable.get(fd);
      if (!entry) {
        const err = new Error('EBADF: bad file descriptor, ftruncate');
        err.code = 'EBADF';
        err.errno = -9;
        err.syscall = 'ftruncate';
        throw err;
      }
      const content = fs.existsSync(entry.path) ? fs.readFileSync(entry.path, 'utf8') : '';
      const newLen = len ?? 0;
      if (content.length > newLen) {
        fs.writeFileSync(entry.path, content.slice(0, newLen));
      } else {
        let padded = content;
        while (padded.length < newLen) padded += '\\0';
        fs.writeFileSync(entry.path, padded);
      }
    },

    // Async methods - wrap sync methods in callbacks/promises

    readFile(path, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      if (callback) {
        try {
          callback(null, fs.readFileSync(path, options));
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.readFileSync(path, options));
      }
    },

    writeFile(path, data, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      if (callback) {
        try {
          fs.writeFileSync(path, data, options);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.writeFileSync(path, data, options));
      }
    },

    appendFile(path, data, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      if (callback) {
        try {
          fs.appendFileSync(path, data, options);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.appendFileSync(path, data, options));
      }
    },

    readdir(path, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      if (callback) {
        try {
          callback(null, fs.readdirSync(path, options));
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.readdirSync(path, options));
      }
    },

    mkdir(path, options, callback) {
      if (typeof options === 'function') {
        callback = options;
        options = undefined;
      }
      if (callback) {
        try {
          fs.mkdirSync(path, options);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.mkdirSync(path, options));
      }
    },

    rmdir(path, callback) {
      if (callback) {
        try {
          fs.rmdirSync(path);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.rmdirSync(path));
      }
    },

    exists(path, callback) {
      if (callback) {
        callback(fs.existsSync(path));
      } else {
        return Promise.resolve(fs.existsSync(path));
      }
    },

    stat(path, callback) {
      if (callback) {
        try {
          callback(null, fs.statSync(path));
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.statSync(path));
      }
    },

    lstat(path, callback) {
      if (callback) {
        try {
          callback(null, fs.lstatSync(path));
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.lstatSync(path));
      }
    },

    unlink(path, callback) {
      if (callback) {
        try {
          fs.unlinkSync(path);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.unlinkSync(path));
      }
    },

    rename(oldPath, newPath, callback) {
      if (callback) {
        try {
          fs.renameSync(oldPath, newPath);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.renameSync(oldPath, newPath));
      }
    },

    copyFile(src, dest, callback) {
      if (callback) {
        try {
          fs.copyFileSync(src, dest);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.copyFileSync(src, dest));
      }
    },

    open(path, flags, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      if (callback) {
        try {
          callback(null, fs.openSync(path, flags, mode));
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.openSync(path, flags, mode));
      }
    },

    close(fd, callback) {
      if (callback) {
        try {
          fs.closeSync(fd);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.closeSync(fd));
      }
    },

    read(fd, buffer, offset, length, position, callback) {
      if (callback) {
        try {
          const bytesRead = fs.readSync(fd, buffer, offset, length, position);
          callback(null, bytesRead, buffer);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.readSync(fd, buffer, offset, length, position));
      }
    },

    write(fd, buffer, offset, length, position, callback) {
      if (typeof offset === 'function') {
        callback = offset;
        offset = undefined;
        length = undefined;
        position = undefined;
      } else if (typeof length === 'function') {
        callback = length;
        length = undefined;
        position = undefined;
      } else if (typeof position === 'function') {
        callback = position;
        position = undefined;
      }
      if (callback) {
        try {
          const bytesWritten = fs.writeSync(fd, buffer, offset, length, position);
          callback(null, bytesWritten, buffer);
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.writeSync(fd, buffer, offset, length, position));
      }
    },

    fstat(fd, callback) {
      if (callback) {
        try {
          callback(null, fs.fstatSync(fd));
        } catch (e) {
          callback(e);
        }
      } else {
        return Promise.resolve(fs.fstatSync(fd));
      }
    },

    // fs.promises API
    promises: {
      readFile: (path, options) => Promise.resolve(fs.readFileSync(path, options)),
      writeFile: (path, data, options) => Promise.resolve(fs.writeFileSync(path, data, options)),
      appendFile: (path, data, options) => Promise.resolve(fs.appendFileSync(path, data, options)),
      readdir: (path, options) => Promise.resolve(fs.readdirSync(path, options)),
      mkdir: (path, options) => Promise.resolve(fs.mkdirSync(path, options)),
      rmdir: (path) => Promise.resolve(fs.rmdirSync(path)),
      stat: (path) => Promise.resolve(fs.statSync(path)),
      lstat: (path) => Promise.resolve(fs.lstatSync(path)),
      unlink: (path) => Promise.resolve(fs.unlinkSync(path)),
      rename: (oldPath, newPath) => Promise.resolve(fs.renameSync(oldPath, newPath)),
      copyFile: (src, dest) => Promise.resolve(fs.copyFileSync(src, dest)),
      access: (path) => Promise.resolve(fs.existsSync(path) ? undefined : (() => { throw new Error('ENOENT'); })()),
    },

    // Compatibility aliases
    accessSync(path) {
      if (!fs.existsSync(path)) {
        const err = new Error("ENOENT: no such file or directory, access '" + path + "'");
        err.code = 'ENOENT';
        err.errno = -2;
        err.syscall = 'access';
        err.path = path;
        throw err;
      }
    },

    access(path, mode, callback) {
      if (typeof mode === 'function') {
        callback = mode;
        mode = undefined;
      }
      if (callback) {
        try {
          fs.accessSync(path);
          callback(null);
        } catch (e) {
          callback(e);
        }
      } else {
        return fs.promises.access(path);
      }
    },

    realpathSync(path) {
      // In our virtual fs, just normalize the path
      return String(path).replace(/\\/\\/+/g, '/').replace(/\\/$/, '') || '/';
    },

    realpath(path, callback) {
      if (callback) {
        callback(null, fs.realpathSync(path));
      } else {
        return Promise.resolve(fs.realpathSync(path));
      }
    },

    createReadStream(path, options) {
      // Basic readable stream simulation
      const content = fs.readFileSync(path, options?.encoding || 'utf8');
      return {
        on(event, handler) {
          if (event === 'data') {
            setTimeout(() => handler(content), 0);
          } else if (event === 'end') {
            setTimeout(() => handler(), 0);
          } else if (event === 'error') {
            // No error
          }
          return this;
        },
        pipe(dest) {
          dest.write(content);
          dest.end();
          return dest;
        }
      };
    },

    createWriteStream(path, options) {
      let content = '';
      return {
        write(chunk) {
          content += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          return true;
        },
        end(chunk) {
          if (chunk) this.write(chunk);
          fs.writeFileSync(path, content);
        },
        on() { return this; }
      };
    },

    // Watch (no-op)
    watch() {
      return { close() {}, on() { return this; } };
    },

    watchFile() {},
    unwatchFile() {},
  };

  return fs;
})()
`;
