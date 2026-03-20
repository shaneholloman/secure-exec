const { Client } = require("ssh2");

async function main() {
	const result = await new Promise((resolve) => {
		const conn = new Client();

		conn.on("ready", () => {
			conn.end();
			resolve({ error: null, connected: true });
		});

		conn.on("error", (err) => {
			resolve({
				error: err.message,
				level: err.level,
				connected: false,
			});
		});

		conn.connect({
			host: process.env.SSH_HOST,
			port: Number(process.env.SSH_PORT),
			username: "testuser",
			password: "wrongpassword",
		});
	});

	console.log(JSON.stringify(result));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
