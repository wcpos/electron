import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

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

// White-listed channels.
const ipc = {
	render: {
		// From render to main.
		send: ['clearData', 'print-external-url', 'open-external-url'] as string[],
		// From main to render.
		on: ['system-resume'] as string[], // System events from main process
		// From render to main and back again.
		invoke: ['sqlite', 'axios', 'rxStorage', 'auth:prompt'] as string[],
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
		// Allow dynamic channels for print callbacks
		const validChannels = [/^onBeforePrint-/, /^onAfterPrint-/, /^onPrintError-/, ...ipc.render.on];
		if (
			validChannels.some((regex) =>
				typeof regex === 'string' ? regex === channel : regex.test(channel)
			)
		) {
			const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => func(...args);
			ipcRenderer.on(channel, subscription);

			// Return unsubscribe function
			return function unsubscribe() {
				return ipcRenderer.removeListener(channel, subscription);
			};
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
		// Allow dynamic channels for print callbacks
		const validChannels = [
			/^onBeforePrint-/,
			/^onAfterPrint-/,
			/^onPrintError-/,
			...ipc.render.once,
		];
		if (
			validChannels.some((regex) =>
				typeof regex === 'string' ? regex === channel : regex.test(channel)
			)
		) {
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
