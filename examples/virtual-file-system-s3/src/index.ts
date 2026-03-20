import {
	NodeRuntime,
	allowAllFs,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "secure-exec";
import {
	S3Client,
	CreateBucketCommand,
	DeleteBucketCommand,
	ListObjectsV2Command,
	DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { S3FileSystem } from "./s3-filesystem.js";

const BUCKET = "secure-exec-vfs-test";

// Connect to MinIO (S3-compatible) running on localhost
const client = new S3Client({
	endpoint: "http://localhost:9000",
	region: "us-east-1",
	credentials: {
		accessKeyId: "minioadmin",
		secretAccessKey: "minioadmin",
	},
	forcePathStyle: true,
});

// Create test bucket
try {
	await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
} catch (err: unknown) {
	const e = err as { name?: string };
	if (
		e.name !== "BucketAlreadyOwnedByYou" &&
		e.name !== "BucketAlreadyExists"
	) {
		throw err;
	}
}

const filesystem = new S3FileSystem({ client, bucket: BUCKET });

const runtime = new NodeRuntime({
	systemDriver: createNodeDriver({
		filesystem,
		permissions: { ...allowAllFs },
	}),
	runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

try {
	// Sandbox writes files — stored in MinIO via S3 API
	const writeResult = await runtime.exec(`
		const fs = require("node:fs");
		fs.mkdirSync("/workspace", { recursive: true });
		fs.writeFileSync("/workspace/hello.txt", "hello from sandbox via S3");
		fs.writeFileSync("/workspace/data.json", JSON.stringify({ count: 42 }));
		console.log("files written");
	`);

	if (writeResult.code !== 0) {
		throw new Error(`Write step failed: ${writeResult.errorMessage}`);
	}

	// Sandbox reads files back
	let readOutput = "";
	const readResult = await runtime.exec(
		`
		const fs = require("node:fs");
		const text = fs.readFileSync("/workspace/hello.txt", "utf8");
		const data = JSON.parse(fs.readFileSync("/workspace/data.json", "utf8"));
		const entries = fs.readdirSync("/workspace");
		console.log(JSON.stringify({ text, count: data.count, entries }));
	`,
		{
			onStdio: (event) => {
				if (event.channel === "stdout") readOutput += event.message;
			},
		},
	);

	if (readResult.code !== 0) {
		throw new Error(`Read step failed: ${readResult.errorMessage}`);
	}

	// Verify from host side via S3 API
	const hostContent = await filesystem.readTextFile("/workspace/hello.txt");
	const parsed = JSON.parse(readOutput.trim());

	const ok =
		hostContent === "hello from sandbox via S3" &&
		parsed.text === "hello from sandbox via S3" &&
		parsed.count === 42 &&
		parsed.entries.includes("hello.txt") &&
		parsed.entries.includes("data.json");

	console.log(
		JSON.stringify({
			ok,
			hostContent,
			sandboxResult: parsed,
			summary:
				"S3-backed VFS: sandbox wrote files to MinIO, read them back, host verified via S3 API",
		}),
	);
} finally {
	runtime.dispose();

	// Clean up: delete all objects and the bucket
	const list = await client.send(
		new ListObjectsV2Command({ Bucket: BUCKET }),
	);
	for (const obj of list.Contents ?? []) {
		await client.send(
			new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }),
		);
	}
	await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
}
