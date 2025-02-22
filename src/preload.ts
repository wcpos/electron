import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

/**
 * Expose the basePath to the renderer process.
 *
 * @NOTE - This is a synchronous call, it will block the thread, but it's a quick call.
 * This is needed for the bundle splitting to work correctly.
 */
contextBridge.exposeInMainWorld('electron', {
	basePath: ipcRenderer.sendSync('getBasePathSync'),
});

// White-listed channels.
const ipc = {
	render: {
		// From render to main.
		send: ['clearData', 'print-external-url'] as string[],
		// From main to render.
		on: [] as string[], // We'll handle dynamic channels separately
		// From render to main and back again.
		invoke: ['sqlite', 'axios', 'rxStorage'] as string[],
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
		if (validChannels.some((regex) => regex.test(channel))) {
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
		if (validChannels.some((regex) => regex.test(channel))) {
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
	from: (data, encoding) => Buffer.from(data, encoding),
	alloc: (size) => Buffer.alloc(size),
	isBuffer: (obj) => Buffer.isBuffer(obj),
	concat: (buffers, totalLength) => Buffer.concat(buffers, totalLength),
});
