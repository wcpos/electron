import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// White-listed channels.
const ipc = {
	render: {
		// From render to main.
		send: ['clearData'] as string[],
		// From main to render.
		on: [] as string[],
		// From render to main and back again.
		invoke: ['sqlite', 'axios'] as string[],
		// From main to render, once
		once: ['ipc-example'] as string[],
	},
};

/**
 * @TODO - change general ipcRenderer apiKey to specific ones for sqlite and axios
 * @TODO - use electron net instead of axios, this will enable localhost requests
 */
contextBridge.exposeInMainWorld('ipcRenderer', {
	send(channel: string, args: unknown[]) {
		const validChannels = ipc.render.send;
		if (validChannels.includes(channel)) {
			ipcRenderer.send(channel, args);
		} else {
			throw Error('No channel found');
		}
	},
	on(channel: string, func: (...args: unknown[]) => void) {
		const validChannels = ipc.render.on;
		if (validChannels.includes(channel)) {
			const subscription = (_event: IpcRendererEvent, ...args: unknown[]) => func(...args);
			ipcRenderer.on(channel, subscription);

			// returns unsubscribe function
			return function unsubscribe() {
				return ipcRenderer.removeListener(channel, subscription);
			};
		}

		throw Error('No channel found');
	},
	invoke(channel: string, args: unknown[]) {
		const validChannels = ipc.render.invoke;
		if (validChannels.includes(channel)) {
			return ipcRenderer.invoke(channel, args);
		}
		return Promise.reject();
	},
	once(channel: string, func: (...args: unknown[]) => void) {
		const validChannels = ipc.render.once;
		if (validChannels.includes(channel)) {
			ipcRenderer.once(channel, (_event: IpcRendererEvent, ...args: unknown[]) => func(...args));
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
