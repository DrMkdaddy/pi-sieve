import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candidate } from "./router-core.ts";

export interface SystemOneEndpointConfig {
	url: string;
	model: string;
	apiKey?: string;
}

export interface SieveConfig {
	/** Classifier pin ("auto" or "<provider>/<id>") */
	classifier: string;
	/** Optional direct System One HTTP endpoint (llama.cpp / laya-serve) */
	systemOne?: SystemOneEndpointConfig;
	/** Auto-thinking enabled at startup */
	autoThinking: boolean;
	/** Custom model cascades overriding built-in defaults */
	cascades?: {
		compaction?: Candidate[];
		fast?: Candidate[];
		pro?: Candidate[];
		free?: Candidate[];
	};
}

export function defaultConfigPath(): string {
	return process.env.PI_SIEVE_CONFIG?.trim() || path.join(os.homedir(), ".pi", "agent", "pi-sieve.json");
}

function isCandidateArray(v: unknown): v is Candidate[] {
	return (
		Array.isArray(v) &&
		v.every(
			(item) =>
				item !== null &&
				typeof item === "object" &&
				typeof (item as Candidate).provider === "string" &&
				typeof (item as Candidate).id === "string",
		)
	);
}

/** Load user config from ~/.pi/agent/pi-sieve.json plus PI_SIEVE_* env overrides. */
export function loadSieveConfig(configPath = defaultConfigPath()): SieveConfig {
	let fileCfg: Partial<SieveConfig> = {};
	try {
		if (fs.existsSync(configPath)) {
			fileCfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<SieveConfig>;
		}
	} catch {
		// Malformed config falls back safely to defaults.
	}

	const envUrl = process.env.PI_SIEVE_SYSTEMONE_URL?.trim();
	const envModel = process.env.PI_SIEVE_SYSTEMONE_MODEL?.trim();
	const envKey = process.env.PI_SIEVE_SYSTEMONE_KEY?.trim();

	const systemOne: SystemOneEndpointConfig | undefined = envUrl
		? {
				url: envUrl,
				model: envModel || fileCfg.systemOne?.model || "openjev",
				...(envKey || fileCfg.systemOne?.apiKey ? { apiKey: envKey || fileCfg.systemOne?.apiKey } : {}),
			}
		: fileCfg.systemOne?.url
			? {
					url: fileCfg.systemOne.url,
					model: envModel || fileCfg.systemOne.model || "openjev",
					...(envKey || fileCfg.systemOne.apiKey ? { apiKey: envKey || fileCfg.systemOne.apiKey } : {}),
				}
			: undefined;

	const envAutoThinking = process.env.PI_SIEVE_AUTO_THINKING?.trim().toLowerCase();
	const autoThinking =
		envAutoThinking === "0" || envAutoThinking === "false"
			? false
			: envAutoThinking === "1" || envAutoThinking === "true"
				? true
				: typeof fileCfg.autoThinking === "boolean"
					? fileCfg.autoThinking
					: true;

	const cascades = fileCfg.cascades
		? {
				...(isCandidateArray(fileCfg.cascades.compaction) ? { compaction: fileCfg.cascades.compaction } : {}),
				...(isCandidateArray(fileCfg.cascades.fast) ? { fast: fileCfg.cascades.fast } : {}),
				...(isCandidateArray(fileCfg.cascades.pro) ? { pro: fileCfg.cascades.pro } : {}),
				...(isCandidateArray(fileCfg.cascades.free) ? { free: fileCfg.cascades.free } : {}),
			}
		: undefined;

	return {
		classifier: process.env.PI_SIEVE_CLASSIFIER?.trim() || fileCfg.classifier || "auto",
		...(systemOne ? { systemOne } : {}),
		autoThinking,
		...(cascades && Object.keys(cascades).length > 0 ? { cascades } : {}),
	};
}
