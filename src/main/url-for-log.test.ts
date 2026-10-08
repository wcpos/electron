import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { urlForLog } from './url-for-log';

try {
	const cases = [
		['wcpos://-/?param=fixture-query&other=fixture-query#fixture-hash', 'wcpos://-/'],
		['wcpos://-/#param=fixture-hash', 'wcpos://-/'],
		[
			'https://demo.example.com/wcpos-auth/?redirect_uri=wcpos%3A%2F%2F-%2F&state=fixture-query',
			'https://demo.example.com/wcpos-auth/',
		],
		[
			'https://user:fixture-pass@demo.example.com:8443/a/b?c=fixture-query',
			'https://demo.example.com:8443/a/b',
		],
		['not a url fixture-query', '<unparsable url>'],
	];
	for (const [input, expected] of cases) {
		const output = urlForLog(input);
		assert.equal(output, expected);
		assert.equal(output.includes('fixture'), false);
	}

	for (const file of ['auth-handler.ts', 'protocol.ts']) {
		const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
		assert.doesNotMatch(source, /log\.\w+\([^)]*\$\{(?:url|authUrl|navigationUrl)\}/);
	}

	console.log('url-for-log tests passed');
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
