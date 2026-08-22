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
let lifecycleChain: Promise<unknown> = Promise.resolve();
/** Bumped on every dispose, so SDK calls can tell their client was replaced mid-flight. */
let sessionGeneration = 0;

/**
 * init/disconnect run strictly in arrival order. Two overlapping inits would
 * otherwise both pass the subscriber check before either assigns `client`,
 * leaving the first client's socket connected with no owner.
 */
function enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
	const run = lifecycleChain.then(operation, operation);
	lifecycleChain = run.then(
		(): undefined => undefined,
		(): undefined => undefined
	);
	return run;
}

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
	sessionGeneration += 1;
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

/**
 * Run an SDK call against the active client and refuse its result if init or
 * disconnect replaced that client while the call was in flight — otherwise a
 * fetch started for subscriber A could be returned after B became active.
 */
async function withActiveClient<T>(operation: (novu: Novu) => Promise<T>): Promise<T> {
	const session = sessionGeneration;
	const result = await operation(requireClient());
	if (session !== sessionGeneration) {
		throw new Error('Novu session changed while the request was in flight');
	}
	return result;
}

async function handleRequest(request: NovuBridgeRequest): Promise<unknown> {
	switch (request.type) {
		case 'init':
			return enqueueLifecycle(() => initClient(request));
		case 'disconnect':
			return enqueueLifecycle(async () => {
				await disposeClient();
				return true;
			});
		case 'waitReady': {
			if (!readyPromise) return false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					readyPromise.then(() => true),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), request.timeoutMs ?? 5000);
					}),
				]);
			} finally {
				clearTimeout(timer);
			}
		}
		case 'fetchNotifications': {
			const response = await withActiveClient((novu) =>
				novu.notifications.list({ limit: request.limit ?? 50 })
			);
			return jsonPlain(sdkData(response).notifications);
		}
		case 'markAsRead':
			sdkData(
				await withActiveClient((novu) =>
					novu.notifications.read({ notificationId: request.notificationId })
				)
			);
			return true;
		case 'markAllAsRead':
			sdkData(await withActiveClient((novu) => novu.notifications.readAll()));
			return true;
		case 'markAsSeen':
			sdkData(
				await withActiveClient((novu) =>
					novu.notifications.seen({ notificationId: request.notificationId })
				)
			);
			return true;
		case 'markAllAsSeen':
			sdkData(await withActiveClient((novu) => novu.notifications.seenAll()));
			return true;
		case 'getUnreadCount': {
			const response = await withActiveClient((novu) => novu.notifications.count({ read: false }));
			return sdkData(response).count;
		}
		default:
			throw new Error(`Unknown Novu request type: ${String((request as { type: unknown }).type)}`);
	}
}

async function initClient(request: Extract<NovuBridgeRequest, { type: 'init' }>): Promise<boolean> {
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

function isNovuBridgeRequest(value: unknown): value is NovuBridgeRequest {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { type?: unknown }).type === 'string'
	);
}

export function registerNovuBridge(): void {
	handleIpc('novu', async (_event, request): Promise<NovuBridgeResponse> => {
		// Validate before dispatch so a malformed invoke (null, a bare string, a
		// missing type) gets the advertised { success: false } shape instead of a
		// rejected IPC promise — and the catch below can never throw on request.type.
		if (!isNovuBridgeRequest(request)) {
			const message = 'Invalid Novu request: expected an object with a string "type"';
			logger.error(message);
			return { success: false, message };
		}
		try {
			return { success: true, result: await handleRequest(request) };
		} catch (error) {
			const message = errorMessage(error);
			logger.error(`Novu ${request.type} failed: ${message}`);
			return { success: false, message };
		}
	});
}
