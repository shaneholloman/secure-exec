import { setGlobalValue } from "../common/global-access";

const __timingConfig = globalThis.__runtimeTimingMitigationConfig ?? {};

const __frozenTimeMs =
	typeof __timingConfig.frozenTimeMs === "number" &&
	Number.isFinite(__timingConfig.frozenTimeMs)
		? __timingConfig.frozenTimeMs
		: Date.now();
const __frozenDateNow = () => __frozenTimeMs;

try {
	Object.defineProperty(Date, "now", {
		value: __frozenDateNow,
		configurable: true,
		writable: true,
	});
} catch {
	Date.now = __frozenDateNow;
}

const __frozenPerformanceNow = () => 0;
const __performance = globalThis.performance;
if (typeof __performance !== "undefined" && __performance !== null) {
	try {
		Object.defineProperty(__performance, "now", {
			value: __frozenPerformanceNow,
			configurable: true,
			writable: true,
		});
	} catch {
		try {
			Object.assign(__performance, { now: __frozenPerformanceNow });
		} catch {}
	}
} else {
	setGlobalValue("performance", {
		now: __frozenPerformanceNow,
	});
}

/* Harden SharedArrayBuffer removal — neuter prototype so saved refs are useless,
   then lock the global property so sandbox code cannot restore it. */
const __OrigSAB = globalThis.SharedArrayBuffer;
if (typeof __OrigSAB === "function") {
	// Neuter the prototype so any previously-saved reference produces broken instances
	try {
		const proto = __OrigSAB.prototype;
		if (proto) {
			for (const key of [
				"byteLength",
				"slice",
				"grow",
				"maxByteLength",
				"growable",
			]) {
				try {
					Object.defineProperty(proto, key, {
						get() {
							throw new TypeError(
								"SharedArrayBuffer is not available in sandbox",
							);
						},
						configurable: false,
					});
				} catch {
					/* property may not exist or be non-configurable */
				}
			}
		}
	} catch {
		/* best-effort prototype neutering */
	}
}

// Lock the global to undefined — configurable: false prevents re-definition
try {
	Object.defineProperty(globalThis, "SharedArrayBuffer", {
		value: undefined,
		configurable: false,
		writable: false,
		enumerable: false,
	});
} catch {
	// Fallback: delete then set
	Reflect.deleteProperty(globalThis, "SharedArrayBuffer");
	setGlobalValue("SharedArrayBuffer", undefined);
}
