# lightweight sandbox

## overview

goal: design an emulated linux machine using WebAssembly.sh for Linux emulation and isolated-vm for the node emulation. thses are both bound to the same core "virtual machine" for filesystem & network & etc. this allows for emulating a linux environment without sacrificing performance (mostly, polyfills have some overhead) on the NodeJS app since it's in an isoalte.

the closest prior art is WebContainers, OpenWebContainers, and Nodebox. however, these all use web or WASM.

## project structure

- use typescript
- keep all in a single package in src/
- add a script check-types to check that types are working
- use vitest to test your work

loosely follow this structure, keep things simple:

```
src/
    vm/
        index.ts  # class VirtualMachine
        fs.ts  # class FileSystemManager
        ...etc...
    node-process/
        index.ts  # class NodeProcess (using isolated-vm)
        ...etc...
    wasix/
        index.ts  # class Wasix
        node-shim.ts  # handles shim between wasix <-> node-process (using isolated-vm)
    ...etc...
```

the end user api looks like:

```
const vm = new VirtualMachine("/path/to/local/fs");
const output = await vm.spawn("ls", ["/"]);
console.log('output', output.stdout, output.stderr, output.code)
```

by the end of this project, we should be able to do:

```
const shCode = `
#!/bin/sh
node script.js
`;

const jsCode = `
const fs = require("fs");  // imports native node package
// TODO: do some basic fs operations

const ms = require("ms");  // imports npm package that doesn't have external deps
// TODO: do smth basic with ms

const jsonfile = require("jsonfile");
// TODO: do somethign basic with this, use `fs` to check it worked
`;

const vm = new VirtualMachine("/path/to/local/fs");

// TODO: run `npm install jsonfile ms` on the HOST so the node_modules files live there
// TODO: write shCode -> test.sh, jsCode to script.js

const output = await vm.spawn("sh", ["-c", "test.sh"]);  // TODO: this command might be wrong
console.log('output', output.stdout, output.stderr, output.code)
```

## components

### virtual machine:

this vm will be bound to BOTH the node shim. we only care about the file system for now, nothing else.

1. implement a basic virtual machine with a fake file system. expose methods on this that forwards to a dedicated folder for this vm. keep this simple and add as needed.

### node shim

1. get basic isolates & bindings working using islated-vm
2. impl ndoejs require with polyfill for node stdlib
    - ipml basic test suite for this
3. implement package imports using the code in node_modules
    - try to import & use a simple package (TBD what we should test)

### wasix vm

1. get basic shell working
2. get file system bindings working (test ls, cd, etc)
2. auto-install `node` program in wasix/webassembly.sh to kick out to the nodejs shim that will spawn the isolate


## future work

- terminal emulation
- get claude code cli working in this emulator
- emulate npm
- use node_modules instead of pulling packages from cdn

