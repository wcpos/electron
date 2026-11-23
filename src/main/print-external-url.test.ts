import assert from 'assert/strict';
import Module from 'module';
import { mock } from 'node:test';

/**
 * The external receipt print window (print-external-url) must report exactly
 * one outcome per print job, ignore subframe and aborted loads, never close a
 * window twice, time out instead of leaking a hidden window, and refuse to
 * open further windows. Bad arguments are rejected before any window exists.
 */

type Handler = (...args: unknown[]) => unknown;

class BrowserWindowMock {
	static created: BrowserWindowMock[] = [];
	static nextPrint: () => Promise<unknown> = () => Promise.resolve();
	static nextLoad: () => Promise<void> = () => new Promise<void>(() => {});

	handlers = new Map<string, { handler: Handler; once: boolean }[]>();
	executeCalls = 0;
	closeCalls = 0;
	destroyed = false;
	windowOpenHandler: Handler | null = null;
	print = BrowserWindowMock.nextPrint;
	load = BrowserWindowMock.nextLoad;

	webContents = {
		on: (name: string, handler: Handler) => this.addHandler(name, handler, false),
		once: (name: string, handler: Handler) => this.addHandler(name, handler, true),
		executeJavaScript: () => {
			this.executeCalls += 1;
			return this.print();
		},
		setWindowOpenHandler: (handler: Handler) => {
			this.windowOpenHandler = handler;
		},
	};

	constructor() {
		BrowserWindowMock.created.push(this);
	}

	addHandler(name: string, handler: Handler, once: boolean) {
		const list = this.handlers.get(name) ?? [];
		list.push({ handler, once });
		this.handlers.set(name, list);
	}

	emit(name: string, ...args: unknown[]) {
		const list = this.handlers.get(name) ?? [];
		this.handlers.set(
			name,
			list.filter((entry) => !entry.once)
		);
		for (const entry of list) entry.handler(...args);
	}

	once() {}
	on() {}
	loadURL(): Promise<void> {
		return this.load();
	}
	isDestroyed() {
		return this.destroyed;
	}
	close() {
		if (this.destroyed) throw new Error('Object has been destroyed');
		this.closeCalls += 1;
		this.destroyed = true;
	}
}

type IpcListener = (event: unknown, args: unknown) => unknown;
const ipcOnListeners = new Map<string, IpcListener>();

const electronMock = {
	BrowserWindow: BrowserWindowMock,
	ipcMain: {
		on(channel: string, listener: IpcListener) {
			ipcOnListeners.set(channel, listener);
		},
	},
};

const loggerMock = { info() {}, warn() {}, error() {} };

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;
mutableModule._load = function patchedLoad(
	request: string,
	parent: NodeModule | null,
	isMain: boolean
) {
	if (request === 'electron') return electronMock;
	if (request === './log') return { logger: loggerMock, logger2: loggerMock };
	return originalLoad.call(this, request, parent, isMain);
};

const VALID_URL = 'https://store.example.com/receipt?key=wc_order_x';
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function startJob(args: { externalURL: unknown; printJobId: unknown }) {
	const sent: unknown[][] = [];
	const before = BrowserWindowMock.created.length;
	const listener = ipcOnListeners.get('print-external-url');
	assert.ok(listener, 'print-external-url should register an ipc listener');
	listener!({ sender: { send: (...msg: unknown[]) => sent.push(msg) } }, args);
	const win = BrowserWindowMock.created[before];
	return { sent, win, created: BrowserWindowMock.created.length - before };
}

function channels(sent: unknown[][]) {
	return sent.map((msg) => msg[0]);
}

async function main() {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		require('./print-external-url');
	} finally {
		mutableModule._load = originalLoad;
	}

	// 1. Bad id: no window, nothing sent.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: '../x' });
		assert.equal(job.created, 0, 'a bad printJobId must not open a window');
		assert.deepEqual(job.sent, [], 'a bad printJobId must not get a reply');
	}

	// 2. Bad URL scheme: no window, exactly one onPrintError.
	{
		const job = startJob({ externalURL: 'file:///etc/passwd', printJobId: 'job-2' });
		assert.equal(job.created, 0, 'a URL that is not a printable URL must not open a window');
		assert.deepEqual(job.sent, [['onPrintError-job-2', 'Invalid print URL']]);
	}

	// 3. Happy path: onBeforePrint, one onAfterPrint, close once after the delay.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-3' });
		assert.equal(job.created, 1);
		job.win.emit('did-finish-load');
		await flush();
		assert.deepEqual(channels(job.sent), ['onBeforePrint-job-3', 'onAfterPrint-job-3']);
		assert.equal(job.win.closeCalls, 0, 'the window stays open for the close delay');
		mock.timers.tick(1000);
		assert.equal(job.win.closeCalls, 1, 'the window closes after the delay');
		mock.timers.tick(30_000);
		assert.deepEqual(
			channels(job.sent),
			['onBeforePrint-job-3', 'onAfterPrint-job-3'],
			'the load timeout must be cleared once the job finished'
		);
		assert.equal(job.win.closeCalls, 1);
	}

	// 4. A second did-finish-load does not print again.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-4' });
		job.win.emit('did-finish-load');
		job.win.emit('did-finish-load');
		await flush();
		assert.equal(job.win.executeCalls, 1, 'window.print() must run at most once');
		assert.equal(channels(job.sent).filter((c) => c === 'onAfterPrint-job-4').length, 1);
		mock.timers.tick(1000);
	}

	// 5. Subframe failure is ignored.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-5' });
		job.win.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://ads.example/', false);
		await flush();
		assert.deepEqual(job.sent, [], 'a subframe failure must not be reported');
		assert.equal(job.win.closeCalls, 0, 'a subframe failure must not close the window');
		job.win.emit('did-finish-load');
		await flush();
		mock.timers.tick(1000);
	}

	// 6. Aborted main-frame load (-3) is ignored.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-6' });
		job.win.emit('did-fail-load', {}, -3, 'ERR_ABORTED', VALID_URL, true);
		await flush();
		assert.deepEqual(job.sent, [], 'ERR_ABORTED must not be reported');
		assert.equal(job.win.closeCalls, 0);
		job.win.emit('did-finish-load');
		await flush();
		mock.timers.tick(1000);
	}

	// 7. Two main-frame failures: one onPrintError, no throw, one close.
	{
		BrowserWindowMock.nextLoad = () => Promise.reject(new Error('ERR_NAME_NOT_RESOLVED'));
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-7' });
		BrowserWindowMock.nextLoad = () => new Promise<void>(() => {});
		assert.doesNotThrow(() => {
			job.win.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', VALID_URL, true);
			job.win.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', VALID_URL, true);
		});
		await flush();
		assert.deepEqual(job.sent, [['onPrintError-job-7', 'ERR_NAME_NOT_RESOLVED']]);
		assert.equal(job.win.closeCalls, 1, 'the window is closed exactly once');
	}

	// 8. Main-frame failure, then a rejected print: still one onPrintError.
	{
		BrowserWindowMock.nextPrint = () => Promise.reject(new Error('print blew up'));
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-8' });
		BrowserWindowMock.nextPrint = () => Promise.resolve();
		assert.doesNotThrow(() => {
			job.win.emit('did-fail-load', {}, -105, 'ERR_CONNECTION_REFUSED', VALID_URL, true);
			job.win.emit('did-finish-load');
		});
		await flush();
		const errors = job.sent.filter((msg) => msg[0] === 'onPrintError-job-8');
		assert.deepEqual(errors, [['onPrintError-job-8', 'ERR_CONNECTION_REFUSED']]);
		assert.equal(job.win.closeCalls, 1);
	}

	// 9. Timeout: one onPrintError with the timeout message, window closed.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-9' });
		mock.timers.tick(29_999);
		assert.deepEqual(job.sent, [], 'nothing is reported before the timeout');
		mock.timers.tick(1);
		assert.deepEqual(job.sent, [['onPrintError-job-9', 'Print page load timed out']]);
		assert.equal(job.win.closeCalls, 1, 'a timed-out window is closed');
		mock.timers.tick(30_000);
		assert.equal(job.sent.length, 1);
	}

	// 10. The print window cannot open further windows.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-10' });
		assert.ok(job.win.windowOpenHandler, 'setWindowOpenHandler must be called');
		assert.deepEqual(job.win.windowOpenHandler!({ url: 'https://evil.example/' }), {
			action: 'deny',
		});
		job.win.emit('did-finish-load');
		await flush();
		mock.timers.tick(1000);
	}

	// 11. A window destroyed during the close delay (the user closed it) is not closed again.
	{
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-11' });
		job.win.emit('did-finish-load');
		await flush();
		job.win.destroyed = true;
		assert.doesNotThrow(() => mock.timers.tick(1000), 'closing a destroyed window must not throw');
		assert.equal(job.win.closeCalls, 0);
	}

	// 12. A data:text/html receipt (system printer) prints like an http(s) page.
	{
		const job = startJob({
			externalURL: 'data:text/html;charset=utf-8,%3Cp%3Ereceipt%3C%2Fp%3E',
			printJobId: 'job-12',
		});
		assert.equal(job.created, 1, 'a data:text/html receipt must open one print window');
		job.win.emit('did-finish-load');
		await flush();
		assert.deepEqual(channels(job.sent), ['onBeforePrint-job-12', 'onAfterPrint-job-12']);
		mock.timers.tick(1000);
		assert.equal(job.win.closeCalls, 1, 'the data: receipt window closes after the delay');
	}

	// 13. Other data: media types are refused: no window, exactly one onPrintError.
	for (const [externalURL, printJobId] of [
		['data:text/plain,x', 'job-13a'],
		['data:image/svg+xml,%3Csvg%2F%3E', 'job-13b'],
	]) {
		const job = startJob({ externalURL, printJobId });
		assert.equal(job.created, 0, `${externalURL} must not open a window`);
		assert.deepEqual(job.sent, [[`onPrintError-${printJobId}`, 'Invalid print URL']]);
	}

	// 14. A print dialog left open past the load timeout is not reported or closed under the user.
	{
		let closeDialog: () => void = () => {};
		BrowserWindowMock.nextPrint = () => new Promise<void>((resolve) => (closeDialog = resolve));
		const job = startJob({ externalURL: VALID_URL, printJobId: 'job-14' });
		BrowserWindowMock.nextPrint = () => Promise.resolve();
		job.win.emit('did-finish-load');
		await flush();
		mock.timers.tick(60_000);
		assert.deepEqual(
			channels(job.sent),
			['onBeforePrint-job-14'],
			'the load timer must stop once the page has loaded'
		);
		assert.equal(job.win.closeCalls, 0, 'the window must stay open while the dialog is open');
		closeDialog();
		await flush();
		assert.deepEqual(channels(job.sent), ['onBeforePrint-job-14', 'onAfterPrint-job-14']);
		mock.timers.tick(1000);
		assert.equal(job.win.closeCalls, 1, 'the window closes after the dialog and the delay');
	}

	mock.timers.reset();
	console.log('print-external-url assertions passed');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
