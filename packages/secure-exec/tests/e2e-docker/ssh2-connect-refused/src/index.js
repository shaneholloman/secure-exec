const { Client } = require("ssh2");

async function main() {
	// Connect to a port where nothing is listening (SSH container's host, port 1)
	const result = await new Promise((resolve) => {
		const conn = new Client();

		conn.on("ready", () => {
			conn.end();
			resolve({ error: null, connected: true });
		});

		conn.on("error", (err) => {
			resolve({
				error: err.message,
				connected: false,
			});
		});

		conn.connect({
			host: process.env.SSH_HOST,
			port: 1,
			username: "testuser",
			password: "testpass",
			readyTimeout: 5000,
		});
	});

	console.log(JSON.stringify(result));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
