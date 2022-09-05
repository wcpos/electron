import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// White-listed channels.
const ipc = {
	render: {
		// From render to main.
		send: ['ipc-example'] as string[],
		// From main to render.
		on: [] as string[],
		// From render to main and back again.
		invoke: ['sqlite', 'axios'] as string[],
		// From main to render, once
		once: ['ipc-example'] as string[],
	},
};

/**
 *
 */
contextBridge.exposeInMainWorld('ipcRenderer', {
	send(channel: string, args: unknown[]) {
		const validChannels = ipc.render.send;
		if (validChannels.includes(channel)) {
			ipcRenderer.send(channel, args);
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

// /**
//  *
//  */
// contextBridge.exposeInMainWorld(
// 	// Allowed 'ipcRenderer' methods.
// 	'ipcRenderer',
// 	{
// 		// From render to main.
// 		send: (channel: 'string', args) => {
// 			const validChannels = ipc.render.send;
// 			if (validChannels.includes(channel)) {
// 				ipcRenderer.send(channel, args);
// 			}
// 		},
// 		// From main to render.
// 		receive: (channel, listener) => {
// 			const validChannels = ipc.render.receive;
// 			if (validChannels.includes(channel)) {
// 				// Deliberately strip event as it includes `sender`
// 				ipcRenderer.on(channel, (event, ...args) => listener(...args));
// 			}
// 		},
// 		// From render to main and back again - async
// 		invoke: (channel, args) => {
// 			const validChannels = ipc.render.sendReceive;
// 			if (validChannels.includes(channel)) {
// 				return ipcRenderer.invoke(channel, args);
// 			}
// 			return Promise.reject();
// 		},
// 	}
// );

// /**
//  *
//  */
// contextBridge.exposeInMainWorld('sqlite', {
// 	open: (name) => {
// 		return ipcRenderer.invoke('sqlite', { type: 'open', name });
// 	},
// 	all: (name, sql) => {
// 		return ipcRenderer.invoke('sqlite', { type: 'all', name, sql });
// 	},
// 	run: (name, sql) => {
// 		return ipcRenderer.invoke('sqlite', { type: 'run', name, sql });
// 	},
// });
