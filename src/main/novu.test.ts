import assert from 'node:assert/strict';
import Module from 'node:module';

type Listener = (data: { result?: unknown }) => void;

const handlers = new Map<string, (...args: any[]) => unknown>();
const sentEvents: { channel: string; payload: unknown }[] = [];
const fakeWebContents = {
	isDestroyed: () => false,
	send(channel: string, payload: unknown) {
		sentEvents.push({ channel, payload });
	},
};

class NotificationModel {
	constructor(
		public id: string,
		public subject: string
	) {}

	prototypeMethod() {
		return this.id;
	}
}

class FakeNovu {
	static instances: FakeNovu[] = [];

	readonly listeners = new Map<string, Set<Listener>>();
	readonly calls: { method: string; args: unknown }[] = [];
	readonly options: Record<string, unknown>;
	disconnectCalls = 0;
	unsubscribeCalls = 0;
	listResult: unknown = { data: { notifications: [] } };
	countResult: unknown = { data: { count: 0 } };
	actionResult: unknown = { data: undefined };

	readonly socket = {
		disconnect: () => {
			this.disconnectCalls += 1;
		},
	};

	readonly notifications = {
		list: async (args: unknown) => {
			this.calls.push({ method: 'list', args });
			return this.resolve(this.listResult);
		},
		read: async (args: unknown) => this.action('read', args),
		readAll: async () => this.action('readAll', undefined),
		seen: async (args: unknown) => this.action('seen', args),
		seenAll: async () => this.action('seenAll', undefined),
		count: async (args: unknown) => {
			this.calls.push({ method: 'count', args });
			return this.resolve(this.countResult);
		},
	};

	constructor(options: Record<string, unknown>) {
		this.options = options;
		FakeNovu.instances.push(this);
	}

	on(event: string, listener: Listener) {
		const listeners = this.listeners.get(event) ?? new Set<Listener>();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => {
			this.unsubscribeCalls += 1;
			listeners.delete(listener);
		};
	}

	emit(event: string, result?: unknown) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener({ result });
		}
	}

	private async action(method: string, args: unknown) {
		this.calls.push({ method, args });
		return this.resolve(this.actionResult);
	}

	private resolve(result: unknown) {
		if (result instanceof Error) {
			return Promise.reject(result);
		}
		return Promise.resolve(result);
	}
}

type ModuleWithMutableLoad = typeof Module & {
	_load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
};

const mutableModule = Module as ModuleWithMutableLoad;
const originalLoad = mutableModule._load;

async function main() {
	mutableModule._load = function patchedLoad(
		request: string,
		parent: NodeModule | null,
		isMain: boolean
	) {
		if (request === '@novu/js') return { Novu: FakeNovu };
		if (request === 'electron') {
			return {
				ipcMain: {
					handle(channel: string, handler: (...args: any[]) => unknown) {
						handlers.set(channel, handler);
					},
				},
			};
		}
		if (request === './window') {
			return { getMainWindow: () => ({ webContents: fakeWebContents }) };
		}
		if (request === './log') {
			return { logger: { error() {}, info() {}, warn() {}, debug() {} } };
		}
		return originalLoad.call(this, request, parent, isMain);
	};

	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { registerNovuBridge } = require('./novu') as {
			registerNovuBridge(): void;
		};
		registerNovuBridge();
		const invoke = handlers.get('novu');
		assert.ok(invoke, 'novu invoke handler should be registered');

		for (const malformed of [null, undefined, 'init', 42, {}, { type: 7 }]) {
			const response = (await invoke(null, malformed)) as { success: boolean; message?: string };
			assert.equal(
				response.success,
				false,
				`malformed request ${JSON.stringify(malformed)} must not succeed`
			);
			assert.match(response.message ?? '', /Invalid Novu request/);
		}
		assert.match(
			((await invoke(null, { type: 'bogus' })) as { message: string }).message,
			/Unknown Novu request type: bogus/
		);

		const initRequest = {
			type: 'init',
			subscriberId: 'subscriber-a',
			locale: 'en-US',
			applicationIdentifier: 'app-id',
			apiUrl: 'https://api.example.test',
			socketUrl: 'wss://socket.example.test',
		};
		assert.deepEqual(await invoke(null, initRequest), { success: true, result: true });
		assert.equal(FakeNovu.instances.length, 1);
		assert.deepEqual(FakeNovu.instances[0]?.options, {
			applicationIdentifier: 'app-id',
			apiUrl: 'https://api.example.test',
			socketUrl: 'wss://socket.example.test',
			subscriber: { subscriberId: 'subscriber-a', locale: 'en-US' },
		});
		assert.equal('data' in ((FakeNovu.instances[0]?.options.subscriber ?? {}) as object), false);

		await invoke(null, { ...initRequest, apiUrl: 'https://ignored.example.test' });
		assert.equal(FakeNovu.instances.length, 1, 'same subscriber init should be idempotent');

		const firstClient = FakeNovu.instances[0]!;
		assert.deepEqual(await invoke(null, { ...initRequest, subscriberId: 'subscriber-b' }), {
			success: true,
			result: true,
		});
		assert.equal(firstClient.disconnectCalls, 1);
		assert.equal(firstClient.unsubscribeCalls, 4);
		assert.equal(FakeNovu.instances.length, 2);

		assert.deepEqual(await invoke(null, { type: 'waitReady', timeoutMs: 1 }), {
			success: true,
			result: false,
		});
		const client = FakeNovu.instances[1]!;
		client.emit('session.initialize.resolved');
		assert.deepEqual(await invoke(null, { type: 'waitReady', timeoutMs: 5 }), {
			success: true,
			result: true,
		});
		assert.deepEqual(sentEvents[sentEvents.length - 1], {
			channel: 'novu:event',
			payload: { kind: 'session_ready' },
		});

		const notification = new NotificationModel('notification-1', 'Hello');
		client.emit('notifications.notification_received', notification);
		const received = sentEvents[sentEvents.length - 1]?.payload as {
			kind: string;
			notification: Record<string, unknown>;
		};
		assert.deepEqual(received, {
			kind: 'notification_received',
			notification: { id: 'notification-1', subject: 'Hello' },
		});
		assert.equal(Object.getPrototypeOf(received.notification), Object.prototype);
		assert.equal('prototypeMethod' in received.notification, false);

		client.emit('notifications.unread_count_changed', { total: 4 });
		client.emit('notifications.unseen_count_changed', 3);
		assert.deepEqual(sentEvents.slice(-2), [
			{ channel: 'novu:event', payload: { kind: 'unread_count_changed', count: 4 } },
			{ channel: 'novu:event', payload: { kind: 'unseen_count_changed', count: 3 } },
		]);

		client.listResult = { data: { notifications: [notification] } };
		assert.deepEqual(await invoke(null, { type: 'fetchNotifications', limit: 10 }), {
			success: true,
			result: [{ id: 'notification-1', subject: 'Hello' }],
		});
		client.countResult = { data: { count: 7 } };
		assert.deepEqual(await invoke(null, { type: 'getUnreadCount' }), {
			success: true,
			result: 7,
		});

		for (const [request, method, args] of [
			[{ type: 'markAsRead', notificationId: 'n1' }, 'read', { notificationId: 'n1' }],
			[{ type: 'markAllAsRead' }, 'readAll', undefined],
			[{ type: 'markAsSeen', notificationId: 'n2' }, 'seen', { notificationId: 'n2' }],
			[{ type: 'markAllAsSeen' }, 'seenAll', undefined],
		] as const) {
			assert.deepEqual(await invoke(null, request), { success: true, result: true });
			assert.deepEqual(client.calls[client.calls.length - 1], { method, args });
		}
		assert.deepEqual(
			client.calls.find((call) => call.method === 'list'),
			{
				method: 'list',
				args: { limit: 10 },
			}
		);
		assert.deepEqual(
			client.calls.find((call) => call.method === 'count'),
			{
				method: 'count',
				args: { read: false },
			}
		);

		client.actionResult = { error: new Error('SDK failure') };
		assert.deepEqual(await invoke(null, { type: 'markAllAsRead' }), {
			success: false,
			message: 'SDK failure',
		});
		client.listResult = new Error('network failure');
		assert.deepEqual(await invoke(null, { type: 'fetchNotifications' }), {
			success: false,
			message: 'network failure',
		});

		assert.deepEqual(await invoke(null, { type: 'disconnect' }), {
			success: true,
			result: true,
		});
		assert.equal(client.disconnectCalls, 1);
		assert.equal(client.unsubscribeCalls, 4);

		// Overlapping lifecycle calls must serialize: a duplicate init arriving
		// before the first finishes must not create a second client, and a
		// subscriber switch mid-flight must dispose the superseded client.
		const instancesBefore = FakeNovu.instances.length;
		const [duplicateFirst, duplicateSecond] = await Promise.all([
			invoke(null, { ...initRequest, subscriberId: 'subscriber-c' }),
			invoke(null, { ...initRequest, subscriberId: 'subscriber-c' }),
		]);
		assert.deepEqual(duplicateFirst, { success: true, result: true });
		assert.deepEqual(duplicateSecond, { success: true, result: true });
		assert.equal(
			FakeNovu.instances.length,
			instancesBefore + 1,
			'concurrent duplicate init created an extra client'
		);
		await Promise.all([
			invoke(null, { ...initRequest, subscriberId: 'subscriber-d' }),
			invoke(null, { ...initRequest, subscriberId: 'subscriber-e' }),
		]);
		assert.equal(FakeNovu.instances.length, instancesBefore + 3);
		const supersededC = FakeNovu.instances[instancesBefore]!;
		const supersededD = FakeNovu.instances[instancesBefore + 1]!;
		assert.equal(supersededC.disconnectCalls, 1, 'superseded client c was not disposed');
		assert.equal(supersededD.disconnectCalls, 1, 'superseded client d was not disposed');
		// An SDK call that settles after init switched subscribers must not leak the
		// old subscriber's data into the new session.
		const activeBefore = FakeNovu.instances.length;
		const staleClient = FakeNovu.instances[activeBefore - 1]!;
		let releaseStaleList: (() => void) | null = null;
		staleClient.listResult = new Promise((resolve) => {
			releaseStaleList = () =>
				resolve({ data: { notifications: [{ id: 'stale-from-previous-subscriber' }] } });
		});
		const staleFetch = invoke(null, { type: 'fetchNotifications' }) as Promise<unknown>;
		assert.deepEqual(
			await invoke(null, { ...initRequest, subscriberId: 'subscriber-after-stale' }),
			{
				success: true,
				result: true,
			}
		);
		assert.equal(FakeNovu.instances.length, activeBefore + 1);
		assert.ok(releaseStaleList, 'the stale list call should be pending');
		releaseStaleList!();
		assert.deepEqual(await staleFetch, {
			success: false,
			message: 'Novu session changed while the request was in flight',
		});
		// The new session is unaffected.
		assert.deepEqual(await invoke(null, { type: 'fetchNotifications' }), {
			success: true,
			result: [],
		});
	} finally {
		mutableModule._load = originalLoad;
	}

	console.log('novu bridge assertions passed');
}

main().catch((error) => {
	mutableModule._load = originalLoad;
	console.error(error);
	process.exitCode = 1;
});
