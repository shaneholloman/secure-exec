const mysql = require("mysql2/promise");

async function main() {
	const conn = await mysql.createConnection({
		host: process.env.MYSQL_HOST,
		port: Number(process.env.MYSQL_PORT),
		user: "testuser",
		password: "testpass",
		database: "testdb",
	});

	await conn.execute(
		"CREATE TABLE IF NOT EXISTS test_e2e (id INT AUTO_INCREMENT PRIMARY KEY, value VARCHAR(255))",
	);
	await conn.execute("INSERT INTO test_e2e (value) VALUES (?)", [
		"hello-sandbox",
	]);
	const [rows] = await conn.execute(
		"SELECT value FROM test_e2e WHERE value = ?",
		["hello-sandbox"],
	);
	await conn.execute("DROP TABLE test_e2e");
	await conn.end();

	console.log(
		JSON.stringify({
			connected: true,
			rowCount: rows.length,
			value: rows[0].value,
		}),
	);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
