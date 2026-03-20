const { Client } = require("ssh2");

async function main() {
	const result = await new Promise((resolve, reject) => {
		const conn = new Client();

		conn.on("ready", () => {
			conn.sftp((err, sftp) => {
				if (err) return reject(err);

				const testDir = "/home/testuser/upload/test-dir-e2e";
				const testFile = testDir + "/hello.txt";
				const fileContent = "hello-from-sftp-dirs";

				// Create directory
				sftp.mkdir(testDir, (err) => {
					if (err) return reject(err);

					// List empty directory
					sftp.readdir(testDir, (err, emptyList) => {
						if (err) return reject(err);
						const emptyNames = emptyList.map((e) => e.filename).sort();

						// Create a file inside the directory
						const ws = sftp.createWriteStream(testFile);
						ws.end(fileContent, () => {
							// List directory again (should contain the file)
							sftp.readdir(testDir, (err, fileList) => {
								if (err) return reject(err);
								const fileNames = fileList.map((e) => e.filename).sort();

								// Remove the file
								sftp.unlink(testFile, (err) => {
									if (err) return reject(err);

									// Remove the directory
									sftp.rmdir(testDir, (err) => {
										conn.end();
										if (err) return reject(err);
										resolve({
											dirCreated: true,
											emptyDirContents: emptyNames,
											afterFileContents: fileNames,
											cleaned: true,
										});
									});
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
