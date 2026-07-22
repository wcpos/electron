import type { BrowserWindow, MenuItem } from 'electron';

/** Everything downstream wiring needs from startup. Grows if more shared handles appear. */
export interface AppContext {
	mainWindow: BrowserWindow;
	updater: AppUpdater;
}

export interface AppUpdater {
	init: () => void;
	manualCheckForUpdates: (menuItem: MenuItem) => Promise<void>;
	setMainWindow?: (mainWindow: BrowserWindow) => void;
}

export interface BootDeps {
	whenReady: () => Promise<unknown>;
	loadTranslations: () => void | Promise<void>;
	clearPendingAppDataOnStartup: () => void | Promise<void>;
	installExtensions: () => void | Promise<void>;
	initializeRxdbStorageBridge: () => void | Promise<void>;
	createWindow: () => BrowserWindow | null | void;
	getMainWindow: () => BrowserWindow | null;
	registerBluetoothSelection: (window: BrowserWindow) => void;
	registerScannerDeviceSelection: (window: BrowserWindow) => void;
	initAuthHandler: () => void;
	initProtocolHandling: () => void;
	registerMenu: () => void;
	createUpdater: (mainWindow: BrowserWindow) => AppUpdater;
	isDevelopment: boolean;
	logger: {
		info: (...args: unknown[]) => void;
		warn?: (...args: unknown[]) => void;
	};
}

/**
 * The phases run, in order. Each entry is the human-readable name plus the thunk.
 * Exported so a test can assert the sequence without launching Electron.
 */
export interface BootPhase {
	name: string;
	run: (ctx: Partial<AppContext>) => void | Promise<void>;
}

export function createMainWindowContext(
	deps: Pick<BootDeps, 'createWindow' | 'getMainWindow' | 'logger'>,
	ctx: Partial<AppContext>
): BrowserWindow | null {
	const createdWindow = deps.createWindow();
	const mainWindow = createdWindow || deps.getMainWindow();

	if (!mainWindow) {
		deps.logger.warn?.('Main window was not available after createWindow');
		return null;
	}

	ctx.mainWindow = mainWindow;
	ctx.updater?.setMainWindow?.(mainWindow);

	return mainWindow;
}

export function wireMainWindowConsumers(
	deps: Pick<BootDeps, 'registerBluetoothSelection' | 'registerScannerDeviceSelection'>,
	ctx: Partial<AppContext>
): void {
	if (ctx.mainWindow) {
		deps.registerBluetoothSelection(ctx.mainWindow);
		deps.registerScannerDeviceSelection(ctx.mainWindow);
	}
}

/** The canonical, ordered boot plan. Pure data — safe to import and inspect in a test. */
export function bootPlan(deps: BootDeps): BootPhase[] {
	return [
		{
			name: 'translations',
			run: () => deps.loadTranslations(),
		},
		{
			name: 'clear-pending-app-data',
			run: () => deps.clearPendingAppDataOnStartup(),
		},
		{
			name: 'install-extensions',
			run: () => deps.installExtensions(),
		},
		{
			name: 'storage-bridge',
			run: () => deps.initializeRxdbStorageBridge(),
		},
		{
			name: 'create-window',
			run: (ctx) => {
				deps.logger.info('Starting app');
				createMainWindowContext(deps, ctx);
			},
		},
		{
			name: 'bluetooth-selection',
			run: (ctx) => wireMainWindowConsumers(deps, ctx),
		},
		{
			name: 'auth-handler',
			run: () => deps.initAuthHandler(),
		},
		{
			name: 'protocol-handling',
			run: () => {
				if (deps.isDevelopment) {
					// Force protocol handling in development; Forge handles this in production.
					deps.initProtocolHandling();
				}
			},
		},
		{
			name: 'menu',
			run: () => deps.registerMenu(),
		},
		{
			name: 'updater-init',
			run: (ctx) => {
				if (!ctx.mainWindow) {
					deps.logger.warn?.('Skipping updater init because no main window exists');
					return;
				}

				ctx.updater = deps.createUpdater(ctx.mainWindow);
				ctx.updater.init();
			},
		},
	];
}

/** Executes bootPlan() against app.whenReady() and returns the assembled AppContext. */
export async function boot(deps: BootDeps): Promise<AppContext> {
	await deps.whenReady();

	const ctx: Partial<AppContext> = {};
	for (const phase of bootPlan(deps)) {
		await phase.run(ctx);
	}

	if (!ctx.mainWindow) {
		throw new Error('Main window was not created during boot');
	}
	if (!ctx.updater) {
		throw new Error('Auto updater was not configured during boot');
	}

	return ctx as AppContext;
}
