import { BrowserWindow } from 'electron';

import { t } from './translations';
import { getMainWindow } from './window';

export default class ProgressBar {
	private mainWindow: BrowserWindow;
	private progressWindow: BrowserWindow;

	constructor() {
		this.mainWindow = getMainWindow();
		this.createWindow();
	}

	public createWindow(): void {
		const win = new BrowserWindow({
			width: 400,
			height: 70,
			parent: this.mainWindow,
			show: false,
			// modal: true,
			resizable: false,
			title: t('Downloading update...'),
			// frame: false,
			// titleBarStyle: 'hidden',
			/**
			 * Fix for pixelation on some Windows machines
			 * https://www.electronjs.org/docs/latest/faq#the-font-looks-blurry-what-is-this-and-what-can-i-do
			 */
			backgroundColor: '#fff',
		});

		// Remove the menu from the progress window
		win.setMenu(null);

		this.progressWindow = win;

		win.loadURL('data:text/html;charset=UTF8,' + encodeURIComponent(htmlContent));

		win.once('ready-to-show', () => {
			win.show();
		});

		win.on('closed', () => {
			this.progressWindow = null;
			this.mainWindow.setProgressBar(-1, { mode: 'none' });
		});
	}

	public updateProgress(progress: number): void {
		if (this.progressWindow) {
			this.mainWindow.setProgressBar(progress / 100, { mode: 'normal' });
			this.progressWindow.webContents.executeJavaScript(`
					document.querySelector('.progress-bar-inner').style.width = '${progress}%';
				`);
		}
	}

	public close(): void {
		if (this.progressWindow) {
			this.mainWindow.setProgressBar(-1, { mode: 'none' });
			this.progressWindow.close();
			this.progressWindow = null;
		}
	}
}

const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
.progress-bar {
	width: 100%;
	background-color: #e1e4e8; /* Neutral gray background */
	border-radius: 25px;
	overflow: hidden;
	box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15); /* Subtle shadow to give a depth effect */
}

.progress-bar-inner {
	width: 0;
	height: 20px;
	background-color: #00aaff; /* A vibrant blue that is generally seen in progress bars across different OS */
	border-radius: 25px 0 0 25px;
}

.progress-bar.active .progress-bar-inner {
	width: 100%;
}
</style>
</head>
<body>

<div class="progress-bar">
  <div class="progress-bar-inner"></div>
</div>

</body>
</html>
`;
