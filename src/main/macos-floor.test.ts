import assert from 'node:assert/strict';

import { macosTooOld, requiredMacos } from './macos-floor';

// Which macOS an offered update needs: the table by major, unless the manifest names one.
assert.equal(requiredMacos('1.11.12'), undefined);
assert.equal(requiredMacos('2.0.0'), '13.0');
assert.equal(requiredMacos('2.0.1-beta.1'), '13.0');
assert.equal(requiredMacos('3.1.0'), '13.0', 'the highest entry at or below the offered major');
assert.equal(requiredMacos('2.0.0', '14.2'), '14.2');
assert.equal(requiredMacos('1.11.12', '14.2'), '14.2');
assert.equal(requiredMacos('2.0.0', 42), '13.0', 'a non-string manifest minimum is ignored');
assert.equal(requiredMacos('2.0.0', 'soon'), '13.0', 'an unreadable manifest minimum is ignored');

// Whether this Mac is too old for it. Anything unreadable fails open.
assert.equal(macosTooOld('2.0.0', '12.7.6'), '13.0');
assert.equal(macosTooOld('2.0.0', '13.0'), null);
assert.equal(macosTooOld('2.0.0', '15.6.1'), null);
assert.equal(macosTooOld('2.0.0', '26.5'), null);
assert.equal(macosTooOld('1.11.12', '12.7.6'), null);
assert.equal(macosTooOld('2.0.0', undefined), null);
assert.equal(macosTooOld('2.0.0', ''), null);
assert.equal(macosTooOld('2.0.0', '11.7.10', '11.0'), null);

console.log('macos-floor.test.ts passed');
