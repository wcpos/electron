import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

import {
	DYNAMIC_ON_PATTERNS,
	INVOKE_CHANNELS,
	ON_CHANNELS,
	RXDB_IPC_CHANNEL_PREFIX,
	SEND_CHANNELS,
} from './ipc-channels';
import { PRELOAD_EXTRA_INVOKE_CHANNELS } from './preload-channels';
import {
	deserializeRxdbIpcMessage,
	hasBulkWriteAttachmentBlobs,
	hasGetAttachmentDataBase64Return,
	serializeRxdbIpcMessage,
} from './rxdb-ipc-attachments';

// Keep in sync with src/main/window.ts.
const APP_VERSION_ARG_PREFIX = '--wcpos-app-version=';
const INSTALL_ID_ARG_PREFIX = '--wcpos-install-id=';
const versionArg = process.argv.find((arg) => arg.startsWith(APP_VERSION_ARG_PREFIX));
const version = versionArg ? versionArg.slice(APP_VERSION_ARG_PREFIX.length) : '0.0.0';
const installIdArg = process.argv.find((arg) => arg.startsWith(INSTALL_ID_ARG_PREFIX));
const installId = installIdArg ? installIdArg.slice(INSTALL_ID_ARG_PREFIX.length) : '';

// No trailing slash: the Expo bundle puts the slash at the start of split asset paths.
// No `path` import here: the sandboxed preload webpack build only externalizes
// electron/events, so node builtins fail to resolve (see 45176cb).
const basePath = `file://${process.resourcesPath}/dist`;

/**
 * Expose app info to the renderer process.
 *
 * basePath is needed for the bundle splitting to work correctly.
 * version is needed for app-info utility to report correct electron version.
 * installId lets the app bundle's error reports share the main process's
 * per-install id (src/main/install-id.ts); '' when not supplied.
 */
contextBridge.exposeInMainWorld('electron', {
	basePath,
	version,
	installId,
});

const isRxdbStorageChannel = (channel: string) => channel.startsWith(RXDB_IPC_CHANNEL_PREFIX);

const isAllowedChannel = (channel: string, validChannels: readonly (string | RegExp)[]) =>
	validChannels.some((matcher) =>
		typeof matcher === 'string' ? matcher === channel : matcher.test(channel)
	);

const rxdbChannelListeners = new Map<
	string,
	Map<(...args: unknown[]) => void, Set<(event: IpcRendererEvent, ...args: unknown[]) => void>>
>();

function getRxdbChannelListeners(channel: string) {
	let listeners = rxdbChannelListeners.get(channel);
	if (!listeners) {
		listeners = new Map();
		rxdbChannelListeners.set(channel, listeners);
	}
	return listeners;
}

function rememberWrappedRxdbListener(
	channel: string,
	listener: (...args: unknown[]) => void,
	wrappedListener: (event: IpcRendererEvent, ...args: unknown[]) => void
) {
	const listeners = getRxdbChannelListeners(channel);
	let wrappedListeners = listeners.get(listener);
	if (!wrappedListeners) {
		wrappedListeners = new Set();
		listeners.set(listener, wrappedListeners);
	}
	wrappedListeners.add(wrappedListener);
}

function forgetWrappedRxdbListener(
	channel: string,
	listener: (...args: unknown[]) => void,
	wrappedListener?: (event: IpcRendererEvent, ...args: unknown[]) => void
) {
	const listeners = rxdbChannelListeners.get(channel);
	const wrappedListeners = listeners?.get(listener);
	if (!wrappedListeners) {
		return undefined;
	}

	const listenerToRemove = wrappedListener ?? wrappedListeners.values().next().value;
	if (!listenerToRemove) {
		return undefined;
	}

	wrappedListeners.delete(listenerToRemove);
	if (wrappedListeners.size === 0) {
		listeners?.delete(listener);
	}
	if (listeners && listeners.size === 0) {
		rxdbChannelListeners.delete(channel);
	}
	return listenerToRemove;
}

// White-listed channels.
const ipc = {
	render: {
		// From render to main.
		send: SEND_CHANNELS,
		// From main to render.
		on: ON_CHANNELS, // System events from main process
		// From render to main and back again.
		invoke: [...INVOKE_CHANNELS, ...PRELOAD_EXTRA_INVOKE_CHANNELS] as const,
		// From main to render, once
		once: [] as const, // We'll handle dynamic channels separately
	},
};

/**
 * Expose ipcRenderer methods to the renderer process.
 */
contextBridge.exposeInMainWorld('ipcRenderer', {
	send(channel: string, args: unknown) {
		const validChannels: readonly string[] = ipc.render.send;
		if (validChannels.includes(channel)) {
			ipcRenderer.send(channel, args);
		} else {
			throw Error(`Channel ${channel} is not allowed`);
		}
	},
	on(channel: string, func: (...args: unknown[]) => void) {
		if (isRxdbStorageChannel(channel)) {
			const subscription = (event: IpcRendererEvent, ...args: unknown[]) => {
				const [message, ...rest] = args;
				if (!hasGetAttachmentDataBase64Return(message)) {
					func(event, ...args);
					return;
				}

				void deserializeRxdbIpcMessage(message)
					.then((decodedMessage) => {
						func(event, decodedMessage, ...rest);
					})
					.catch((error) => {
						console.error('Failed to decode RxDB IPC attachment payload in preload', error);
					});
			};
			rememberWrappedRxdbListener(channel, func, subscription);
			ipcRenderer.on(channel, subscription);
			return function unsubscribe() {
				const wrappedListener =
					forgetWrappedRxdbListener(channel, func, subscription) ?? subscription;
				return ipcRenderer.removeListener(channel, wrappedListener);
			};
		}

		const validChannels = [...DYNAMIC_ON_PATTERNS, ...ipc.render.on];
		if (isAllowedChannel(channel, validChannels)) {
			const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => func(...args);
			ipcRenderer.on(channel, subscription);

			return function unsubscribe() {
				return ipcRenderer.removeListener(channel, subscription);
			};
		}

		throw Error(`Channel ${channel} is not allowed`);
	},
	removeListener(channel: string, listener: (...args: unknown[]) => void) {
		if (isRxdbStorageChannel(channel)) {
			const wrappedListener = forgetWrappedRxdbListener(channel, listener);
			return ipcRenderer.removeListener(
				channel,
				wrappedListener ?? (listener as (event: IpcRendererEvent, ...args: unknown[]) => void)
			);
		}
		throw Error(`Channel ${channel} is not allowed`);
	},
	postMessage(channel: string, message: unknown) {
		if (isRxdbStorageChannel(channel)) {
			if (!hasBulkWriteAttachmentBlobs(message)) {
				return ipcRenderer.postMessage(channel, message);
			}

			void serializeRxdbIpcMessage(message)
				.then((serializedMessage) => {
					ipcRenderer.postMessage(channel, serializedMessage);
				})
				.catch((error) => {
					console.error('Failed to encode RxDB IPC attachment payload in preload', error);
				});
			return;
		}
		throw Error(`Channel ${channel} is not allowed`);
	},
	invoke(channel: string, args: unknown) {
		const validChannels: readonly string[] = ipc.render.invoke;
		if (validChannels.includes(channel)) {
			return ipcRenderer.invoke(channel, args);
		}
		return Promise.reject(new Error(`Channel ${channel} is not allowed`));
	},
	once(channel: string, func: (...args: unknown[]) => void) {
		const validChannels = [...DYNAMIC_ON_PATTERNS, ...ipc.render.once];
		if (isAllowedChannel(channel, validChannels)) {
			ipcRenderer.once(channel, (_event: IpcRendererEvent, ...args: unknown[]) => func(...args));
		} else {
			throw Error(`Channel ${channel} is not allowed`);
		}
	},
});

// The renderer bundle expects a global Buffer. Keep isBuffer in the main world:
// bridged functions structured-clone arguments, so a Proxy throws "An object could
// not be cloned." before the preload runs, crashing lodash isEqual on RxDB document
// proxies (wcpos/electron#322). It returns false because nothing in the main world
// is a Node Buffer: bridged Buffers arrive as Uint8Array, so the bridged version
// already returned false. func is serialized and must not capture preload scope.
contextBridge.executeInMainWorld({
	func: (bridged: {
		from: (data: any, encoding?: any) => Uint8Array;
		alloc: (size: number) => Uint8Array;
		concat: (buffers: any[], totalLength?: number) => Uint8Array;
	}) => {
		Object.defineProperty(window, 'Buffer', {
			value: Object.freeze({
				from: bridged.from,
				alloc: bridged.alloc,
				concat: bridged.concat,
				isBuffer: () => false,
			}),
			enumerable: true,
		});
	},
	args: [
		{
			from: (data: any, encoding?: any) => Buffer.from(data, encoding),
			alloc: (size: number) => Buffer.alloc(size),
			concat: (buffers: any[], totalLength?: number) => Buffer.concat(buffers, totalLength),
		},
	],
});
