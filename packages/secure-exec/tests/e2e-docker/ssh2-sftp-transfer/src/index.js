const { Client } = require("ssh2");

async function main() {
	const result = await new Promise((resolve, reject) => {
		const conn = new Client();

		conn.on("ready", () => {
			conn.sftp((err, sftp) => {
				if (err) return reject(err);

				const remotePath = "/home/testuser/upload/test-e2e.txt";
				const content = "hello-sftp-sandbox";

				// Write file
				const writeStream = sftp.createWriteStream(remotePath);
				writeStream.end(content, () => {
					// Read it back
					sftp.readFile(remotePath, "utf8", (err, data) => {
						if (err) return reject(err);

						// Stat it
						sftp.stat(remotePath, (err, stats) => {
							if (err) return reject(err);

							// Delete it
							sftp.unlink(remotePath, (err) => {
								conn.end();
								if (err) return reject(err);
								resolve({
									connected: true,
									written: content,
									readBack: data,
									match: data === content,
									size: stats.size,
								});
							});
						});
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
