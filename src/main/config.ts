import fs from 'fs';
import path from 'path';

import { dialog, app } from 'electron';

import logger, { Sentry } from './log';
import { t } from './translations';

const configPath = path.join(app.getPath('userData'), 'config.json');

// Function to read the configuration with error handling
function readConfig() {
	try {
		return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
	} catch (error) {
		logger.error('Error reading config file:', error);
		Sentry.captureException(error);
		return {};
	}
}

// Function to write the configuration with error handling
function writeConfig(config) {
	try {
		fs.writeFileSync(configPath, JSON.stringify(config));
	} catch (error) {
		logger.error('Error writing config file:', error);
		Sentry.captureException(error);
	}
}

// Configuration object
const config = {
	settings: readConfig(),

	get hardwareAcceleration() {
		return this.settings.hardwareAcceleration || true;
	},

	set hardwareAcceleration(value) {
		this.settings.hardwareAcceleration = value;
		writeConfig(this.settings);
	},
};

// Expose a method to change hardware acceleration setting with error handling
const setHardwareAcceleration = (enabled) => {
	try {
		config.hardwareAcceleration = enabled;
	} catch (error) {
		logger.error('Error setting hardware acceleration:', error);
		Sentry.captureException(error);
		dialog.showErrorBox(
			'Error',
			'Failed to update hardware acceleration setting. Please try again.'
		);
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
				// quit and relaunch
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
