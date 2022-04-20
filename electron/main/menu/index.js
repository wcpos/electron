import { Menu } from 'electron';
import { baseAppMenu } from './app';
import { baseFileMenu } from './file';
import { baseHelpMenu } from './help';
import { baseViewMenu } from './view';
import { baseWindowMenu } from './window';

const template = [...baseAppMenu, baseFileMenu, baseViewMenu, baseWindowMenu, baseHelpMenu];

const menu = Menu.buildFromTemplate(template);
export const registerMenu = () => Menu.setApplicationMenu(menu);
