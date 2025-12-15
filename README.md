goal: design an emulated linux machine using WebAssembly.sh for Linux emulation and 

project structure:
- use typescript
- use basic 

node runtime (src/):

1. get basic isolates & bindings working using islated-vm
2. impl ndoejs require with polyfill
    - ipml basic test suite for this
3. implement package imports using cdn (this is TEMPORARY)
    - try to import & use a simple package (TBD)

webassembly.sh:

1. get shell working
2. auto-isntall `node` program kicks out to the node runtime that spawns a node process using isolated-vm

