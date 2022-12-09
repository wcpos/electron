import { Menu } from 'electron';

export const registerMenu = () => {
	/**
	 * Note: I want to translate the menu labels so we need to load these files after appReady
	 */
	const { baseAppMenu } = require('./app');
	const { baseEditMenu } = require('./edit');
	const { baseFileMenu } = require('./file');
	const { baseHelpMenu } = require('./help');
	const { baseViewMenu } = require('./view');
	const { baseWindowMenu } = require('./window');

	const template = [
		...baseAppMenu,
		baseFileMenu,
		baseEditMenu,
		baseViewMenu,
		baseWindowMenu,
		baseHelpMenu,
	];

	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
};
