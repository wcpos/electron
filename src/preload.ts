import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

import {
	deserializeRxdbIpcMessage,
	hasBulkWriteAttachmentBlobs,
	hasGetAttachmentDataBase64Return,
	serializeRxdbIpcMessage,
} from './rxdb-ipc-attachments';

/**
 * Expose app info to the renderer process.
 *
 * @NOTE - These are synchronous calls, they will block the thread, but they're quick calls.
 * basePath is needed for the bundle splitting to work correctly.
 * version is needed for app-info utility to report correct electron version.
 */
contextBridge.exposeInMainWorld('electron', {
	basePath: ipcRenderer.sendSync('getBasePathSync'),
	version: ipcRenderer.sendSync('getAppVersionSync'),
});

const isRxdbStorageChannel = (channel: string) => channel.startsWith('rxdb-ipc-renderer-storage|');

const isAllowedChannel = (channel: string, validChannels: (string | RegExp)[]) =>
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
		send: ['clearData', 'print-external-url', 'open-external-url'] as string[],
		// From main to render.
		on: ['system-resume'] as string[], // System events from main process
		// From render to main and back again.
		invoke: ['sqlite', 'axios', 'rxStorage', 'auth:prompt', 'print-raw-tcp'] as string[],
		// From main to render, once
		once: [] as string[], // We'll handle dynamic channels separately
	},
};

/**
 * Expose ipcRenderer methods to the renderer process.
 */
contextBridge.exposeInMainWorld('ipcRenderer', {
	send(channel: string, args: unknown) {
		const validChannels = ipc.render.send;
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

		const validChannels = [/^onBeforePrint-/, /^onAfterPrint-/, /^onPrintError-/, ...ipc.render.on];
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
		const validChannels = ipc.render.invoke;
		if (validChannels.includes(channel)) {
			return ipcRenderer.invoke(channel, args);
		}
		return Promise.reject(new Error(`Channel ${channel} is not allowed`));
	},
	once(channel: string, func: (...args: unknown[]) => void) {
		const validChannels = [
			/^onBeforePrint-/,
			/^onAfterPrint-/,
			/^onPrintError-/,
			...ipc.render.once,
		];
		if (isAllowedChannel(channel, validChannels)) {
			ipcRenderer.once(channel, (_event: IpcRendererEvent, ...args: unknown[]) => func(...args));
		} else {
			throw Error(`Channel ${channel} is not allowed`);
		}
	},
});

/**
 * For some reason, the Buffer object is not available in the renderer process.
 * perhaps due to context isolation? This is a workaround to expose the Buffer object.
 *
 * https://github.com/electron/electron/blob/5b60698dea0830c8b82d154578afb5e29e83d7df/lib/renderer/init.ts#L120
 * https://www.electronjs.org/docs/latest/tutorial/context-isolation
 */
contextBridge.exposeInMainWorld('Buffer', {
	from: (data: any, encoding?: any) => Buffer.from(data, encoding),
	alloc: (size: number) => Buffer.alloc(size),
	isBuffer: (obj: any) => Buffer.isBuffer(obj),
	concat: (buffers: any[], totalLength?: number) => Buffer.concat(buffers, totalLength),
});
