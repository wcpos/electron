import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findPageTarget } from './smoke-packaged-app.mjs';

const script = fileURLToPath(new URL('./smoke-packaged-app.mjs', import.meta.url));
const wait = (ms) =>
	new Promise((resolve) => {
		setTimeout(resolve, ms).unref();
	});

test('bounds a stalled CDP target request by the discovery deadline', async (t) => {
	const server = http.createServer(() => {});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(9412, '127.0.0.1', resolve);
	});
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});

	const page = await Promise.race([
		findPageTarget(Date.now() + 100),
		wait(2_000).then(() => {
			throw new Error('findPageTarget outlived its deadline');
		}),
	]);
	assert.equal(page, null);
});

test('closes the loopback server when temporary-profile setup fails', async () => {
	const missingTemp = path.join(path.dirname(script), `.missing-smoke-temp-${process.pid}`);
	const child = spawn(process.execPath, [script, script], {
		env: { ...process.env, TMPDIR: missingTemp, TMP: missingTemp, TEMP: missingTemp },
		stdio: ['ignore', 'ignore', 'pipe'],
	});
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => {
		stderr += chunk;
	});

	const result = await Promise.race([
		new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve({ code, signal }));
		}),
		wait(2_000).then(() => {
			child.kill('SIGKILL');
			throw new Error('smoke process remained alive after setup failed');
		}),
	]);

	assert.deepEqual(result, { code: 1, signal: null });
	assert.match(stderr, /ENOENT/);
});
