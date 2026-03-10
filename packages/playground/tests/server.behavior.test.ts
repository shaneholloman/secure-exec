import { afterEach, describe, expect, it } from "vitest";
import { createBrowserPlaygroundServer } from "../backend/server.js";

let server: ReturnType<typeof createBrowserPlaygroundServer> | null = null;

function listenOnRandomPort(s: ReturnType<typeof createBrowserPlaygroundServer>): Promise<number> {
	return new Promise((resolve, reject) => {
		s.listen(0, () => {
			const address = s.address();
			if (!address || typeof address === "string") {
				reject(new Error("Expected a TCP server address"));
				return;
			}
			resolve(address.port);
		});
		s.once("error", reject);
	});
}

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve, reject) => {
			server?.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
		server = null;
	}
});

describe("browser playground server", () => {
	it("serves vendor assets with COEP/COOP headers", async () => {
		server = createBrowserPlaygroundServer();
		const port = await listenOnRandomPort(server);

		const response = await fetch(
			`http://127.0.0.1:${port}/vendor/monaco/vs/loader.js`,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(response.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
		expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
		const body = await response.text();
		expect(body.length).toBeGreaterThan(0);
	});

	it("redirects directory requests to a trailing slash", async () => {
		server = createBrowserPlaygroundServer();
		const port = await listenOnRandomPort(server);

		const response = await fetch(
			`http://127.0.0.1:${port}/frontend`,
			{ redirect: "manual" },
		);

		expect(response.status).toBe(308);
		expect(response.headers.get("location")).toBe("/frontend/");
	});
});
