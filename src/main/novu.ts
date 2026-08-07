import { Novu } from '@novu/js';

import type {
	NovuBridgeEvent,
	NovuBridgeRequest,
	NovuBridgeResponse,
} from '@wcpos/printer/ipc-channels';

import { handleIpc } from './ipc';
import { logger } from './log';
import { getMainWindow } from './window';

type Unsubscribe = () => void;
type SdkResult<T> = { data?: T; error?: unknown };

let client: Novu | null = null;
let activeSubscriberId: string | null = null;
let listenerUnsubscribes: Unsubscribe[] = [];
let readyPromise: Promise<void> | null = null;
let resolveReady: (() => void) | null = null;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sdkData<T>(response: SdkResult<T>): T {
	if (response.error) {
		throw response.error;
	}
	return response.data as T;
}

function jsonPlain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function pushEvent(event: NovuBridgeEvent): void {
	const webContents = getMainWindow()?.webContents;
	if (webContents && !webContents.isDestroyed()) {
		webContents.send('novu:event', event);
	}
}

async function disposeClient(): Promise<void> {
	const previousClient = client;
	client = null;
	activeSubscriberId = null;
	readyPromise = null;
	resolveReady = null;

	for (const unsubscribe of listenerUnsubscribes.splice(0)) {
		try {
			unsubscribe();
		} catch (error) {
			logger.error(`Failed to remove a Novu listener: ${errorMessage(error)}`);
		}
	}

	try {
		const response = await previousClient?.socket.disconnect();
		if (response?.error) {
			logger.error(`Failed to disconnect Novu: ${errorMessage(response.error)}`);
		}
	} catch (error) {
		logger.error(`Failed to disconnect Novu: ${errorMessage(error)}`);
	}
}

function requireClient(): Novu {
	if (!client) {
		throw new Error('Novu client is not initialized');
	}
	return client;
}

async function handleRequest(request: NovuBridgeRequest): Promise<unknown> {
	switch (request.type) {
		case 'init': {
			if (client && activeSubscriberId === request.subscriberId) {
				return true;
			}
			await disposeClient();
			readyPromise = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			client = new Novu({
				applicationIdentifier: request.applicationIdentifier,
				apiUrl: request.apiUrl,
				socketUrl: request.socketUrl,
				subscriber: { subscriberId: request.subscriberId, locale: request.locale },
			});
			activeSubscriberId = request.subscriberId;
			listenerUnsubscribes = [
				client.on('session.initialize.resolved', () => {
					resolveReady?.();
					pushEvent({ kind: 'session_ready' });
				}),
				client.on('notifications.notification_received', (data) => {
					pushEvent({
						kind: 'notification_received',
						notification: jsonPlain(data.result),
					});
				}),
				client.on('notifications.unread_count_changed', (data) => {
					const result = data.result as { total?: number } | undefined;
					pushEvent({ kind: 'unread_count_changed', count: result?.total ?? 0 });
				}),
				client.on('notifications.unseen_count_changed', (data) => {
					pushEvent({ kind: 'unseen_count_changed', count: (data.result as number) ?? 0 });
				}),
			];
			return true;
		}
		case 'disconnect':
			await disposeClient();
			return true;
		case 'waitReady': {
			if (!readyPromise) return false;
			return Promise.race([
				readyPromise.then(() => true),
				new Promise<boolean>((resolve) =>
					setTimeout(() => resolve(false), request.timeoutMs ?? 5000)
				),
			]);
		}
		case 'fetchNotifications': {
			const response = await requireClient().notifications.list({ limit: request.limit ?? 50 });
			return jsonPlain(sdkData(response).notifications);
		}
		case 'markAsRead':
			sdkData(await requireClient().notifications.read({ notificationId: request.notificationId }));
			return true;
		case 'markAllAsRead':
			sdkData(await requireClient().notifications.readAll());
			return true;
		case 'markAsSeen':
			sdkData(await requireClient().notifications.seen({ notificationId: request.notificationId }));
			return true;
		case 'markAllAsSeen':
			sdkData(await requireClient().notifications.seenAll());
			return true;
		case 'getUnreadCount': {
			const response = await requireClient().notifications.count({ read: false });
			return sdkData(response).count;
		}
	}
}

export function registerNovuBridge(): void {
	handleIpc('novu', async (_event, request): Promise<NovuBridgeResponse> => {
		try {
			return { success: true, result: await handleRequest(request) };
		} catch (error) {
			const message = errorMessage(error);
			logger.error(`Novu ${request.type} failed: ${message}`);
			return { success: false, message };
		}
	});
}
