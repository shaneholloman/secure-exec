use std::env;
use std::fs;
use std::thread;
use std::time::Duration;

const IPC_DIR: &str = "/ipc";
const REQUEST_FILE: &str = "/ipc/request.txt";
const RESPONSE_FILE: &str = "/ipc/response.txt";
const MAX_POLLS: u32 = 100;
const POLL_INTERVAL_MS: u64 = 50;

fn main() {
    let args: Vec<String> = env::args().collect();

    // Skip argv[0] (our binary name), pass remaining args as the command
    let cmd_args: Vec<&str> = args.iter().skip(1).map(|s| s.as_str()).collect();

    eprintln!("[wasmer-node-shim] Starting with args: {:?}", cmd_args);

    // Create IPC directory if it doesn't exist (may fail if already exists)
    let _ = fs::create_dir_all(IPC_DIR);

    // Clean up any old response file
    let _ = fs::remove_file(RESPONSE_FILE);

    // Write request file
    // Format: first line is the command, rest are args (one per line)
    let request_content = if cmd_args.is_empty() {
        "node\n".to_string()
    } else {
        cmd_args.join("\n") + "\n"
    };

    eprintln!("[wasmer-node-shim] Writing request to {}", REQUEST_FILE);
    if let Err(e) = fs::write(REQUEST_FILE, &request_content) {
        eprintln!("[wasmer-node-shim] Failed to write request: {}", e);
        std::process::exit(1);
    }
    eprintln!("[wasmer-node-shim] Request written, polling for response...");

    // Poll for response
    let mut polls = 0;
    loop {
        polls += 1;

        if polls > MAX_POLLS {
            eprintln!("[wasmer-node-shim] Timeout waiting for response after {} polls", MAX_POLLS);
            std::process::exit(124); // timeout exit code
        }

        // Check if response file exists
        match fs::read_to_string(RESPONSE_FILE) {
            Ok(content) => {
                eprintln!("[wasmer-node-shim] Got response after {} polls", polls);

                // Parse response: first line is exit code, rest is stdout
                let mut lines = content.lines();
                let exit_code: i32 = lines
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(1);

                let stdout: String = lines.collect::<Vec<_>>().join("\n");

                // Print stdout to our stdout
                if !stdout.is_empty() {
                    println!("{}", stdout);
                }

                // Clean up
                let _ = fs::remove_file(REQUEST_FILE);
                let _ = fs::remove_file(RESPONSE_FILE);

                std::process::exit(exit_code);
            }
            Err(_) => {
                // Response not ready yet, wait and retry
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            }
        }
    }
}
