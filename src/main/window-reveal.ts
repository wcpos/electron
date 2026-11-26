import type { BrowserWindow } from 'electron';

// Under Wayland, a `show: false` window never paints, so `ready-to-show` never fires and the
// window never appears (seen on Debian 13 GNOME, Electron 45). A dialog parented to such an
// unmapped window crashes the process with the xdg-foreign "invalid role" error. Linux
// therefore reveals at once; macOS and Windows still wait for `ready-to-show`.
export function revealWhenReady(
	win: Pick<BrowserWindow, 'once'>,
	reveal: () => void,
	platform: NodeJS.Platform = process.platform
): void {
	if (platform === 'linux') {
		reveal();
		return;
	}
	win.once('ready-to-show', reveal);
}
