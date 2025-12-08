import { BrowserWindow, ipcMain } from 'electron';

import log from './log';
import { getMainWindow } from './window';

interface AuthPromptParams {
	authUrl: string;
	redirectUri: string;
}

interface AuthResult {
	type: 'success' | 'error' | 'dismiss' | 'cancel';
	params?: Record<string, string>;
	error?: string;
}

/**
 * Parse auth tokens from a redirect URL
 */
function parseAuthUrl(url: string): AuthResult {
	try {
		const urlObj = new URL(url);

		// Try query params first, then hash fragment
		let params: URLSearchParams;
		if (urlObj.search) {
			params = urlObj.searchParams;
		} else if (urlObj.hash) {
			params = new URLSearchParams(urlObj.hash.slice(1));
		} else {
			return {
				type: 'error',
				error: 'No auth parameters found in URL',
			};
		}

		// Check for error response
		const error = params.get('error');
		if (error) {
			return {
				type: 'error',
				error: params.get('error_description') || error,
			};
		}

		// Convert URLSearchParams to plain object
		const authParams: Record<string, string> = {};
		params.forEach((value, key) => {
			authParams[key] = value;
		});

		return {
			type: 'success',
			params: authParams,
		};
	} catch (err) {
		return {
			type: 'error',
			error: err instanceof Error ? err.message : 'Failed to parse auth URL',
		};
	}
}

/**
 * Initialize the auth IPC handler
 */
export function initAuthHandler(): void {
	ipcMain.handle('auth:prompt', async (_event, params: AuthPromptParams): Promise<AuthResult> => {
		const { authUrl, redirectUri } = params;

		log.info(`Auth prompt requested: ${authUrl}`);
		log.info(`Redirect URI: ${redirectUri}`);

		const mainWindow = getMainWindow();

		return new Promise((resolve) => {
			// Create modal auth window
			const authWindow = new BrowserWindow({
				width: 500,
				height: 600,
				parent: mainWindow || undefined,
				modal: true,
				show: false,
				autoHideMenuBar: true,
				title: 'Login',
				webPreferences: {
					nodeIntegration: false,
					contextIsolation: true,
					// No preload needed - just loading external auth page
				},
			});

			let resolved = false;

			const cleanup = () => {
				if (!authWindow.isDestroyed()) {
					authWindow.close();
				}
			};

			const resolveOnce = (result: AuthResult) => {
				if (resolved) return;
				resolved = true;
				log.info(`Auth result: ${result.type}`);
				cleanup();
				resolve(result);
			};

			// Show window when ready
			authWindow.once('ready-to-show', () => {
				authWindow.show();
			});

			// Handle window closed by user
			authWindow.on('closed', () => {
				resolveOnce({ type: 'dismiss' });
			});

			// Listen for navigation to our redirect URI or wcpos:// scheme
			authWindow.webContents.on('will-navigate', (event, navigationUrl) => {
				log.info(`Auth window navigating to: ${navigationUrl}`);

				// Check if this is our redirect
				if (navigationUrl.startsWith(redirectUri) || navigationUrl.startsWith('wcpos://')) {
					event.preventDefault();
					log.info(`Auth redirect detected: ${navigationUrl}`);
					const result = parseAuthUrl(navigationUrl);
					resolveOnce(result);
				}
			});

			// Also handle redirects that happen via location change
			authWindow.webContents.on('will-redirect', (event, navigationUrl) => {
				log.info(`Auth window redirecting to: ${navigationUrl}`);

				if (navigationUrl.startsWith(redirectUri) || navigationUrl.startsWith('wcpos://')) {
					event.preventDefault();
					log.info(`Auth redirect detected: ${navigationUrl}`);
					const result = parseAuthUrl(navigationUrl);
					resolveOnce(result);
				}
			});

			// Handle navigation failures
			authWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
				// Ignore aborted loads (happens when we prevent navigation)
				if (errorCode === -3) return;

				log.error(`Auth window failed to load: ${errorCode} - ${errorDescription}`);
				resolveOnce({
					type: 'error',
					error: `Failed to load auth page: ${errorDescription}`,
				});
			});

			// Load the auth URL
			authWindow.loadURL(authUrl).catch((err) => {
				log.error(`Failed to load auth URL: ${err.message}`);
				resolveOnce({
					type: 'error',
					error: `Failed to load auth page: ${err.message}`,
				});
			});
		});
	});

	log.info('Auth handler initialized');
}

