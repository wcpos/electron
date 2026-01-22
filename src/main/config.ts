import { app, dialog } from 'electron';
import Store from 'electron-store';

import logger, { Sentry } from './log';
import { t } from './translations';

// Define the store schema
interface StoreSchema extends Record<string, unknown> {
	hardwareAcceleration: boolean;
}

// Initialize electron-store
const store = new Store<StoreSchema>({
	defaults: {
		hardwareAcceleration: true, // Default value for hardwareAcceleration
	},
});

// Configuration object
const config = {
	get hardwareAcceleration() {
		return store.get('hardwareAcceleration', true);
	},

	set hardwareAcceleration(value) {
		try {
			store.set('hardwareAcceleration', value);
		} catch (error) {
			logger.error('Error setting hardware acceleration in store:', error);
			Sentry.captureException(error);
			throw new Error('Failed to update hardware acceleration setting.');
		}
	},
};

// Expose a method to change hardware acceleration setting with error handling
const setHardwareAcceleration = (enabled: boolean) => {
	try {
		config.hardwareAcceleration = enabled;
	} catch (error) {
		logger.error('Error setting hardware acceleration:', error);
		Sentry.captureException(error);
		dialog.showErrorBox(
			'Error',
			'Failed to update hardware acceleration setting. Please try again.'
		);
		return;
	}

	// Notify the user that they need to restart the app for changes to take effect
	dialog
		.showMessageBox({
			title: t('Hardware Acceleration', { _tags: 'electron' }),
			message: t(
				'Hardware acceleration {enabled}, application will restart for update to take effect.',
				{
					_tags: 'electron',
					enabled: enabled
						? t('enabled', { _tags: 'electron' })
						: t('disabled', { _tags: 'electron' }),
				}
			),
		})
		.then(() => {
			setImmediate(() => {
				// Quit and relaunch
				app.relaunch();
				app.exit(0);
			});
		});
};

// Function to toggle hardware acceleration with error handling
function toggleHardwareAcceleration() {
	try {
		if (!config.hardwareAcceleration) {
			app.disableHardwareAcceleration();
		}
	} catch (error) {
		logger.error('Error toggling hardware acceleration:', error);
		Sentry.captureException(error);
		dialog.showErrorBox(
			'Error',
			'Failed to toggle hardware acceleration. Please restart the application.'
		);
	}
}

export { config, setHardwareAcceleration, toggleHardwareAcceleration };
