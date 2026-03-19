const { Client } = require("pg");

async function main() {
	const client = new Client({
		host: process.env.PG_HOST,
		port: Number(process.env.PG_PORT),
		user: "testuser",
		password: "testpass",
		database: "testdb",
	});

	await client.connect();

	await client.query(
		"CREATE TABLE IF NOT EXISTS test_e2e (id SERIAL PRIMARY KEY, value TEXT)",
	);
	await client.query("INSERT INTO test_e2e (value) VALUES ($1)", [
		"hello-sandbox",
	]);
	const res = await client.query(
		"SELECT value FROM test_e2e WHERE value = $1",
		["hello-sandbox"],
	);
	await client.query("DROP TABLE test_e2e");
	await client.end();

	console.log(
		JSON.stringify({
			connected: true,
			rowCount: res.rowCount,
			value: res.rows[0].value,
		}),
	);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
