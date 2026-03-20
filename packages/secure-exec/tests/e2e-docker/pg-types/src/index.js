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

	// Create table with diverse column types
	await client.query(`
		CREATE TABLE IF NOT EXISTS test_types (
			id SERIAL PRIMARY KEY,
			col_json JSON,
			col_jsonb JSONB,
			col_timestamptz TIMESTAMPTZ,
			col_boolean BOOLEAN,
			col_bytea BYTEA,
			col_int_arr INTEGER[],
			col_text_arr TEXT[],
			col_uuid UUID,
			col_numeric NUMERIC
		)
	`);

	// Fixed test values for deterministic output
	const testJson = { key: "value", nested: { a: 1 } };
	const testJsonb = { tags: ["alpha", "beta"], count: 42 };
	const testTimestamp = "2024-01-15T12:30:00.000Z";
	const testBoolean = true;
	const testBytea = Buffer.from("hello bytea world");
	const testIntArr = [10, 20, 30];
	const testTextArr = ["foo", "bar", "baz"];
	const testUuid = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
	const testNumeric = "12345.6789";

	// Insert row with all types
	await client.query(
		`INSERT INTO test_types
			(col_json, col_jsonb, col_timestamptz, col_boolean, col_bytea,
			 col_int_arr, col_text_arr, col_uuid, col_numeric)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		[
			JSON.stringify(testJson),
			JSON.stringify(testJsonb),
			testTimestamp,
			testBoolean,
			testBytea,
			testIntArr,
			testTextArr,
			testUuid,
			testNumeric,
		],
	);

	// Read back and verify types
	const res = await client.query("SELECT * FROM test_types WHERE id = 1");
	const row = res.rows[0];

	const results = {
		rowCount: res.rowCount,
		json: {
			value: row.col_json,
			type: typeof row.col_json,
			isObject: typeof row.col_json === "object" && row.col_json !== null,
		},
		jsonb: {
			value: row.col_jsonb,
			type: typeof row.col_jsonb,
			isObject: typeof row.col_jsonb === "object" && row.col_jsonb !== null,
		},
		timestamptz: {
			isDate: row.col_timestamptz instanceof Date,
			isoString: row.col_timestamptz instanceof Date
				? row.col_timestamptz.toISOString()
				: String(row.col_timestamptz),
		},
		boolean: {
			value: row.col_boolean,
			type: typeof row.col_boolean,
		},
		bytea: {
			isBuffer: Buffer.isBuffer(row.col_bytea),
			length: row.col_bytea.length,
			decoded: row.col_bytea.toString("utf8"),
		},
		intArray: {
			value: row.col_int_arr,
			isArray: Array.isArray(row.col_int_arr),
			elemType: typeof row.col_int_arr[0],
		},
		textArray: {
			value: row.col_text_arr,
			isArray: Array.isArray(row.col_text_arr),
		},
		uuid: {
			value: row.col_uuid,
			type: typeof row.col_uuid,
		},
		numeric: {
			value: row.col_numeric,
			type: typeof row.col_numeric,
		},
	};

	// Cleanup
	await client.query("DROP TABLE test_types");
	await client.end();

	console.log(JSON.stringify(results));
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
