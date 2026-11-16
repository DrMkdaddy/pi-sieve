import { execFileSync } from "node:child_process";

export interface ClipboardBackend {
	cmd: string;
	args: string[];
	label: string;
}

const BACKENDS: readonly ClipboardBackend[] = [
	{ cmd: "wl-copy", args: [], label: "Wayland (wl-copy)" },
	{ cmd: "xclip", args: ["-selection", "clipboard"], label: "X11 (xclip)" },
	{ cmd: "xsel", args: ["--clipboard", "--input"], label: "X11 (xsel)" },
	{ cmd: "pbcopy", args: [], label: "macOS (pbcopy)" },
];

/** Detect the first working system clipboard CLI across Wayland, X11, and macOS. */
export function detectClipboardBackend(whichFn: (cmd: string) => boolean = defaultHasCmd): ClipboardBackend | undefined {
	for (const b of BACKENDS) {
		if (whichFn(b.cmd)) return b;
	}
	return undefined;
}

function defaultHasCmd(cmd: string): boolean {
	try {
		execFileSync("which", [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function copyToClipboard(text: string): ClipboardBackend {
	const backend = detectClipboardBackend();
	if (!backend) {
		throw new Error("No clipboard CLI found (install wl-clipboard, xclip, xsel, or run on macOS pbcopy)");
	}
	execFileSync(backend.cmd, backend.args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
	return backend;
}
