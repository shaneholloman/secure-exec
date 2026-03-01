import { afterEach, describe, expect, it } from "vitest";
import { NodeProcess } from "../src/index.js";

function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text.charCodeAt(i) === 10) count += 1;
	}
	return count;
}

describe("logging load", () => {
	let proc: NodeProcess | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	it(
		"captures high-volume stdout without truncation (repro for log memory pressure)",
		async () => {
			proc = new NodeProcess();
			const lineCount = 40_000;
			const payloadChars = 256;

			const result = await proc.exec(`
					const lineCount = ${lineCount};
					const payload = "x".repeat(${payloadChars});
					for (let i = 0; i < lineCount; i += 1) {
						console.log(i + ":" + payload);
					}
				`);

			expect(result.code).toBe(0);

			const newlineCount = countNewlines(result.stdout);
			expect(newlineCount).toBe(lineCount);

			// This asserts we retain the full multi-megabyte log payload, which is
			// the behavior that can create host memory pressure under sustained spam.
			expect(result.stdout.length).toBeGreaterThan(10 * 1024 * 1024);
		},
		20_000,
	);
});
