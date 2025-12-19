# technical post

## benefits

TODO

## v8 isolate accelerator

wasix has this virtual fs/io/network.

nodejs implements its own virtual fs/io/network (available as it a generic interface).

in order to integrate this, we implement syscalls for a process's stdin/exit that calls the host. this is done by forwarding everything passed to the wasix process to the host via custom system calls (which are exposed as bindings).

however, we also need to be able to spawn child processes from nodejs. this is core functionality. to do this, we have the inverse of what we just implemented which is to spawn subprocesses processes inside the OS.

## comparison to microvms

## comparison to jailing

## limitations

