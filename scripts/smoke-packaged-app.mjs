/**
 * Smoke-test a PACKAGED build: can the app actually talk to a server?
 *
 * Why this exists
 * ---------------
 * 1.10.1 shipped with every HTTP request dead. The preload gates each invoke on
 * INVOKE_CHANNELS; #354 renamed the transport channel 'axios' -> 'http-request'
 * in main, but this repo's vendored copy of the channel registry kept the old
 * name. Main served 'http-request', the preload permitted 'axios', and the
 * renderer's own guard rejected the call BEFORE IPC — so nothing reached the
 * main process and nothing appeared in the transport log.
 *
 * Every source-level test passed, in both repos, because the defect did not
 * exist in source. The renderer picks the channel name in the monorepo; the
 * preload enforces the allowlist here. No type system spans that seam, and the
 * only place both halves meet is the packaged artifact.
 *
 * So this checks the artifact, from both directions:
 *
 *   1. Statically — every channel the packaged RENDERER invokes must appear in
 *      the packaged PRELOAD's allowlist. This covers the half of the contract
 *      that chooses the channel name, which a hand-written invoke cannot: if the
 *      renderer starts sending a name the preload does not permit, real requests
 *      break even while preload and main agree with each other.
 *   2. At runtime — a real HTTP request through the real preload over the real
 *      bridge, against a local server started here, so the gate needs no network
 *      and cannot flake on someone else's uptime.
 *
 * Usage: node scripts/smoke-packaged-app.mjs <path-to-.app-or-executable>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MARKER = 'wcpos-smoke-ok';
const CDP_PORT = 9412;
const BOOT_TIMEOUT_MS = 60_000;
const CDP_CALL_TIMEOUT_MS = 30_000;

/**
 * Throw rather than exit: process.exit() here would skip main()'s finally and
 * strand the packaged app process and its temporary profile.
 */
class SmokeFailure extends Error {}
const fail = (msg) => {
	throw new SmokeFailure(msg);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve a .app bundle (or a directory containing exactly one) to its executable. */
function resolveBundle(target) {
	if (!target) fail('usage: node scripts/smoke-packaged-app.mjs <path-to-.app>');
	if (!fs.existsSync(target)) fail(`no such path: ${target}`);
	if (fs.statSync(target).isFile()) return { executable: target, appDir: null };

	// A bundle passed directly is the answer — never search inside it, or the
	// Helper (Renderer)/GPU/Plugin bundles under Contents/Frameworks look like hits.
	let appDir = target;
	if (!target.endsWith('.app')) {
		// electron-forge packages to out/<name>-<platform>-<arch>/<name>.app. Collect
		// ALL matches and refuse to guess: silently smoke testing the wrong binary
		// and reporting success is worse than having no gate at all.
		const collect = (dir, depth = 0, acc = []) => {
			if (depth > 3) return acc;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const full = path.join(dir, entry.name);
				if (entry.name.endsWith('.app')) acc.push(full);
				else collect(full, depth + 1, acc);
			}
			return acc;
		};
		const bundles = collect(target);
		if (bundles.length === 0) fail(`no .app bundle under ${target}`);
		if (bundles.length > 1) {
			fail(`found ${bundles.length} .app bundles under ${target}; pass one explicitly:\n  ${bundles.join('\n  ')}`);
		}
		appDir = bundles[0];
	}

	const macosDir = path.join(appDir, 'Contents', 'MacOS');
	const [binary] = fs.readdirSync(macosDir);
	if (!binary) fail(`no executable in ${macosDir}`);
	return { executable: path.join(macosDir, binary), appDir };
}

const readIfPresent = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

/**
 * Compare the two halves of the shipped artifact against each other. No repo
 * source is consulted — the point is that the build is self-consistent.
 */
function crossCheckArtifact(appDir) {
	const resources = path.join(appDir, 'Contents', 'Resources');
	const preload = readIfPresent(
		path.join(resources, 'app', '.webpack', 'renderer', 'main_window', 'preload.js')
	);
	if (!preload) {
		console.log('smoke: preload not found at the expected path — skipping the static cross-check');
		return;
	}

	const allowlistMatch = preload.match(/INVOKE_CHANNELS\s*=\s*\[([^\]]*)\]/);
	if (!allowlistMatch) {
		console.log('smoke: could not read INVOKE_CHANNELS from the preload — skipping the static cross-check');
		return;
	}
	const allowed = new Set([...allowlistMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]));
	if (allowed.size === 0) fail('the packaged preload permits no invoke channels at all');

	const jsDir = path.join(resources, 'dist', '_expo', 'static', 'js', 'web');
	if (!fs.existsSync(jsDir)) {
		console.log('smoke: renderer bundle not found — skipping the static cross-check');
		return;
	}
	const invoked = new Set();
	for (const file of fs.readdirSync(jsDir).filter((f) => f.endsWith('.js'))) {
		const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
		for (const m of source.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)) invoked.add(m[1]);
	}
	if (invoked.size === 0) {
		fail('found no ipcRenderer.invoke channels in the renderer bundle — the scan must not silently match nothing and report success');
	}

	for (const channel of invoked) {
		if (!allowed.has(channel)) {
			fail(
				`the renderer invokes '${channel}' but the packaged preload does not permit it.\n` +
					`  Permitted: ${[...allowed].join(', ')}\n` +
					'  These ship as one artifact, so they must agree.'
			);
		}
	}
	console.log(`smoke: renderer invokes [${[...invoked].join(', ')}] — all permitted by the preload`);
}

async function findPageTarget(deadline) {
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
			const targets = await res.json();
			const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
			if (page) return page;
		} catch {
			// devtools endpoint is not up yet
		}
		await sleep(500);
	}
	return null;
}

/** Evaluate an expression in the renderer. Every wait is bounded — a renderer that
 * opens the socket and then dies must fail the gate, not stall the release job. */
async function evaluate(page, expression) {
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	try {
		await new Promise((res, rej) => {
			const timer = setTimeout(() => rej(new SmokeFailure('timed out attaching to the renderer')), CDP_CALL_TIMEOUT_MS);
			ws.onopen = () => {
				clearTimeout(timer);
				res();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				rej(new SmokeFailure('could not attach to the renderer'));
			};
		});

		const call = (id, method, params) =>
			new Promise((res, rej) => {
				const done = () => {
					clearTimeout(timer);
					ws.removeEventListener('message', onMessage);
					ws.removeEventListener('close', onGone);
					ws.removeEventListener('error', onGone);
				};
				const timer = setTimeout(() => {
					done();
					rej(new SmokeFailure(`the renderer did not answer ${method} within ${CDP_CALL_TIMEOUT_MS}ms`));
				}, CDP_CALL_TIMEOUT_MS);
				const onGone = () => {
					done();
					rej(new SmokeFailure(`the renderer connection closed during ${method}`));
				};
				const onMessage = (ev) => {
					const msg = JSON.parse(ev.data);
					if (msg.id === id) {
						done();
						res(msg);
					}
				};
				ws.addEventListener('message', onMessage);
				ws.addEventListener('close', onGone);
				ws.addEventListener('error', onGone);
				ws.send(JSON.stringify({ id, method, params }));
			});

		await call(1, 'Runtime.enable', {});
		const result = await call(2, 'Runtime.evaluate', {
			expression,
			awaitPromise: true,
			returnByValue: true,
		});
		return result.result?.result?.value;
	} finally {
		ws.close();
	}
}

async function main() {
	const { executable, appDir } = resolveBundle(process.argv[2]);
	console.log(`smoke: ${executable}`);
	if (appDir) crossCheckArtifact(appDir);

	const server = http.createServer((_req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ marker: MARKER }));
	});
	await new Promise((res) => server.listen(0, '127.0.0.1', res));
	const origin = `http://127.0.0.1:${server.address().port}`;

	// A throwaway profile: a release gate must never read or write a real store.
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcpos-smoke-'));
	const child = spawn(executable, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`], {
		stdio: 'ignore',
	});
	child.on('error', (err) => console.error(`smoke: could not launch the app: ${err.message}`));

	try {
		const page = await findPageTarget(Date.now() + BOOT_TIMEOUT_MS);
		if (!page) fail(`the app did not open a renderer within ${BOOT_TIMEOUT_MS}ms`);

		const bridgeShape = await evaluate(page, "typeof window.ipcRenderer + '/' + typeof (window.ipcRenderer||{}).invoke");
		if (bridgeShape !== 'object/function') {
			fail(`the preload did not expose an ipcRenderer.invoke bridge (saw ${bridgeShape})`);
		}

		const outcome = await evaluate(
			page,
			`window.ipcRenderer.invoke('http-request', {
				type: 'request',
				requestId: 'smoke',
				config: { url: ${JSON.stringify(origin)}, method: 'get', timeout: 15000 },
			}).then(r => 'OK:' + r.status + ':' + JSON.stringify(r.data))
			  .catch(e => 'ERR:' + e.message)`
		);

		if (typeof outcome !== 'string') fail(`unreadable result from the renderer: ${outcome}`);
		if (outcome.startsWith('ERR:')) {
			if (/is not allowed/.test(outcome)) {
				fail(
					`the preload rejected the transport channel: ${outcome}\n` +
						'  Main serves this channel but the preload allowlist does not permit it.\n' +
						'  The handlers and INVOKE_CHANNELS have drifted apart — they ship as one\n' +
						'  artifact, so they must agree.'
				);
			}
			fail(`the packaged app could not complete an HTTP request: ${outcome}`);
		}
		if (!outcome.includes(MARKER)) fail(`unexpected response body: ${outcome}`);

		console.log(`smoke: HTTP over the IPC bridge -> ${outcome}`);
		console.log('SMOKE-COMPLETE: the packaged app can reach a server');
	} finally {
		child.kill('SIGKILL');
		server.close();
		fs.rmSync(userDataDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	if (error instanceof SmokeFailure) console.error(`\nSMOKE FAILED: ${error.message}\n`);
	else console.error(error);
	process.exitCode = 1;
});
