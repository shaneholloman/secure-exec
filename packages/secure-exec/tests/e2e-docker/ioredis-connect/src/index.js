const Redis = require("ioredis");

async function main() {
	const redis = new Redis({
		host: process.env.REDIS_HOST,
		port: Number(process.env.REDIS_PORT),
		lazyConnect: false,
	});

	// Basic set/get
	await redis.set("e2e:key", "hello-sandbox");
	const value = await redis.get("e2e:key");

	// Pipeline
	const pipeline = redis.pipeline();
	pipeline.set("e2e:p1", "a");
	pipeline.set("e2e:p2", "b");
	pipeline.get("e2e:p1");
	pipeline.get("e2e:p2");
	const pipeResults = await pipeline.exec();

	// Cleanup
	await redis.del("e2e:key", "e2e:p1", "e2e:p2");
	await redis.quit();

	console.log(
		JSON.stringify({
			connected: true,
			value,
			pipelineP1: pipeResults[2][1],
			pipelineP2: pipeResults[3][1],
		}),
	);
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
