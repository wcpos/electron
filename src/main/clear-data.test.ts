import assert from 'node:assert/strict';
import Module from 'node:module';

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

type Listener = (...args: unknown[]) => unknown;
type DialogResult = { response: number };
type DialogCall = {
	opts: Record<string, unknown>;
	resolve: (value: DialogResult) => void;
	reject: (err: unknown) => void;
};

const CLEAR_FLAG = '--clear-app-data-on-startup';

const onListeners = new Map<string, Listener>();
const handlers = new Map<string, Listener>();
const dialogCalls: DialogCall[] = [];
const relaunchCalls: { args?: string[] }[] = [];
let quitCalls = 0;

const resetRecorders = () => {
	dialogCalls.length = 0;
	relaunchCalls.length = 0;
	quitCalls = 0;
};

const fakeElectron = {
	ipcMain: {
		on(channel: string, fn: Listener) {
			onListeners.set(channel, fn);
		},
		handle(channel: string, fn: Listener) {
			handlers.set(channel, fn);
		},
	},
	dialog: {
		showMessageBox(opts: Record<string, unknown>) {
			return new Promise<DialogResult>((resolve, reject) => {
				dialogCalls.push({ opts, resolve, reject });
			});
		},
	},
	app: {
		relaunch(opts: { args?: string[] }) {
			relaunchCalls.push(opts);
		},
		quit() {
			quitCalls += 1;
		},
	},
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return fakeElectron;
	if (request === './log') return { logger: { info() {}, error() {} } };
	if (request === './rxdb-storage') {
		return { getFilesystemNodeBasePath() {}, getSqliteBasePath() {}, getLegacySqliteBasePath() {} };
	}
	if (request === './translations') return { t: (key: string) => key };
	return originalLoad.call(this, request, parent, isMain);
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

const getHandler = () => {
	const handler = handlers.get('clearData:request');
	assert.ok(handler, "'clearData:request' handler is registered");
	return handler;
};

const lastDialog = () => {
	assert.equal(dialogCalls.length, 1, 'exactly one dialog shown');
	return dialogCalls[0];
};

async function handleRegistered() {
	resetRecorders();
	assert.ok(handlers.has('clearData:request'), "'clearData:request' is in the handle map");
	assert.ok(onListeners.has('clearData'), "'clearData' is still in the on map");
}

async function pendingDialogDoesNotSettle() {
	resetRecorders();
	let settled = false;
	const markSettled = () => {
		settled = true;
	};
	const pending = Promise.resolve(getHandler()({})).then(markSettled, markSettled);
	await nextTurn();
	assert.equal(settled, false, 'invoke is still unsettled while the dialog is open');
	assert.equal(relaunchCalls.length, 0, 'no relaunch while the dialog is open');
	lastDialog().resolve({ response: 1 });
	await pending;
}

async function noDeclines() {
	resetRecorders();
	const result = getHandler()({});
	lastDialog().resolve({ response: 1 });
	assert.equal(await result, 'declined');
	await nextTurn();
	assert.equal(relaunchCalls.length, 0, 'No never relaunches');
	assert.equal(quitCalls, 0, 'No never quits');
}

async function escMapsToNo() {
	resetRecorders();
	const result = getHandler()({});
	const { opts } = lastDialog();
	assert.equal(opts.cancelId, 1, 'Esc / dismissal returns the No button');
	assert.deepEqual(opts.buttons, ['common.yes', 'common.no']);
	lastDialog().resolve({ response: 1 });
	assert.equal(await result, 'declined');
}

async function yesRelaunchesAfterTheReply() {
	resetRecorders();
	const result = getHandler()({});
	lastDialog().resolve({ response: 0 });
	assert.equal(await result, 'relaunching');
	assert.equal(relaunchCalls.length, 0, 'relaunch waits until after the reply');
	assert.equal(quitCalls, 0, 'quit waits until after the reply');
	await nextTurn();
	assert.equal(relaunchCalls.length, 1, 'relaunch called once');
	const args = relaunchCalls[0].args ?? [];
	assert.equal(args[args.length - 1], CLEAR_FLAG);
	assert.equal(args.filter((arg) => arg === CLEAR_FLAG).length, 1);
	assert.equal(quitCalls, 1, 'quit called once');
}

async function legacyChannelStillRelaunchesOnYes() {
	resetRecorders();
	const listener = onListeners.get('clearData');
	assert.ok(listener, "'clearData' listener is registered");
	listener({}, undefined);
	lastDialog().resolve({ response: 0 });
	// Two turns: the dialog answer is only seen after this turn's microtasks,
	// and the relaunch is scheduled on the macrotask after that.
	await nextTurn();
	await nextTurn();
	assert.equal(relaunchCalls.length, 1, 'relaunch called once');
	assert.equal(quitCalls, 1, 'quit called once');
}

async function dialogRejectionRejectsTheInvoke() {
	resetRecorders();
	const failure = new Error('dialog failed');
	const result = Promise.resolve(getHandler()({}));
	lastDialog().reject(failure);
	await assert.rejects(result, (err) => err === failure);
	await nextTurn();
	assert.equal(relaunchCalls.length, 0, 'no relaunch after a dialog failure');
}

async function main() {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./clear-data');
	} finally {
		mutableModule._load = originalLoad;
	}

	const cases: [string, () => Promise<void>][] = [
		['handle registered', handleRegistered],
		['pending dialog does not settle', pendingDialogDoesNotSettle],
		['No declines', noDeclines],
		['Esc maps to No', escMapsToNo],
		['Yes relaunches after the reply', yesRelaunchesAfterTheReply],
		['legacy channel still relaunches on Yes', legacyChannelStillRelaunchesOnYes],
		['dialog rejection rejects the invoke', dialogRejectionRejectsTheInvoke],
	];

	for (const [name, run] of cases) {
		try {
			await run();
		} catch (err) {
			console.error(`FAIL ${name}`);
			throw err;
		}
		console.log(`ok ${name}`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
