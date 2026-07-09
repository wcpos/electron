import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import type { IpcInvokeChannels } from '@wcpos/printer/ipc-channels';

export function handleIpc<C extends keyof IpcInvokeChannels>(
	channel: C,
	handler: (
		event: IpcMainInvokeEvent,
		args: IpcInvokeChannels[C]['req']
	) => Promise<IpcInvokeChannels[C]['res']> | IpcInvokeChannels[C]['res']
): void {
	ipcMain.handle(channel, handler as never);
}
