import { Menu } from 'electron';
import { baseAppMenu } from './app';
import { baseFileMenu } from './file';
import { baseEditMenu } from './edit';
import { baseHelpMenu } from './help';
import { baseViewMenu } from './view';
import { baseWindowMenu } from './window';

const template = [
	...baseAppMenu,
	baseFileMenu,
	baseEditMenu,
	baseViewMenu,
	baseWindowMenu,
	baseHelpMenu,
];

const menu = Menu.buildFromTemplate(template);
export const registerMenu = () => Menu.setApplicationMenu(menu);
