declare global {
	interface Window {
		ipcRenderer: {
			send(channel: string, args: unknown[]): void;
			on(channel: string, func: (...args: unknown[]) => void): (() => void) | undefined;
			invoke(channel: string, args: unknown[]): Promise<any>;
			once(channel: string, func: (...args: unknown[]) => void): void;
		};
	}
}

export {};
