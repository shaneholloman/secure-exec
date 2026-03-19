const { Client } = require("ssh2");

async function main() {
	const result = await new Promise((resolve, reject) => {
		const conn = new Client();

		conn.on("ready", () => {
			conn.exec("echo hello-from-sandbox && whoami", (err, stream) => {
				if (err) return reject(err);

				let stdout = "";
				let stderr = "";

				stream.on("data", (data) => {
					stdout += data.toString();
				});
				stream.stderr.on("data", (data) => {
					stderr += data.toString();
				});
				stream.on("close", (code) => {
					conn.end();
					resolve({
						connected: true,
						code,
						stdout: stdout.trim(),
						stderr: stderr.trim(),
					});
				});
			});
		});

		conn.on("error", reject);

		conn.connect({
			host: process.env.SSH_HOST,
			port: Number(process.env.SSH_PORT),
			username: "testuser",
			password: "testpass",
		});
	});

	console.log(JSON.stringify(result));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
