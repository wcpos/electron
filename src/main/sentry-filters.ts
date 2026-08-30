/**
 * Pure `beforeSend` filters for the main-process Sentry client (src/main/log.ts).
 * No Electron imports, so src/main/sentry-hygiene.test.ts runs under plain ts-node.
 */
export interface SentryEventLike {
	exception?: { values?: { type?: string; value?: string }[] };
	message?: string;
}

export interface ShutdownState {
	/** `app` has emitted `before-quit`. */
	quitting: boolean;
	/** `BrowserWindow.getAllWindows().length` when the event is sent. */
	windowsAlive: number;
}

// The shell's `loadURL` promise rejects with this when its BrowserWindow is
// destroyed mid-load. Sentry issue WOOCOMMERCE-POS-195 collected 183 of them
// across 14 releases, and the sampled events each carried `window.closed` /
// `app.quit` breadcrumbs: a close during a slow start, not a broken shell.
// With a live window and no quit in progress it IS a blank-screen bug, so
// those are kept.
const ABORTED_SHELL_LOAD = /ERR_FAILED \(-2\) loading 'wcpos:\/\/-'/;

export function isAbortedShellLoad(event: SentryEventLike): boolean {
	const values = event.exception?.values ?? [];
	return (
		values.some((value) => ABORTED_SHELL_LOAD.test(value.value ?? '')) ||
		ABORTED_SHELL_LOAD.test(event.message ?? '')
	);
}

export function shouldDropEvent(event: SentryEventLike, state: ShutdownState): boolean {
	return isAbortedShellLoad(event) && (state.quitting || state.windowsAlive === 0);
}
