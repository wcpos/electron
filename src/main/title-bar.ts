import { type BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from 'electron';

import type { WindowColorScheme } from '../ipc-channels';

/**
 * The window draws no native title bar; the renderer's top strip is the drag
 * region instead (`app-region: drag` in wcpos/monorepo apps/main/public/index.html).
 *
 * `titleBarStyle: 'hidden'` rather than `frame: false` — the frame stays, so
 * the OS still supplies the shadow, rounded corners, resize edges, snap layouts
 * and double-click-to-zoom. On macOS the traffic lights remain and are moved
 * to sit centred in the strip; on Windows/Linux Chromium's Window Controls
 * Overlay keeps the native min/max/close buttons. Both platforms then expose
 * `env(titlebar-area-*)` to the page, which is how the renderer keeps its own
 * content out from under the controls without knowing the platform.
 */

/** Must equal the renderer's strip height (`h-10`, 40px) or the controls sit off-centre. */
export const TITLE_BAR_HEIGHT = 40;

/** macOS buttons are 12px: top-left of the close button, centred in the strip. */
export const TRAFFIC_LIGHT_POSITION = { x: 12, y: (TITLE_BAR_HEIGHT - 12) / 2 };

/**
 * Windows/Linux overlay: a transparent background so the renderer's own strip
 * shows through under the buttons, and a glyph colour that follows the app
 * theme (not the OS theme, which `symbolColor` would otherwise default to).
 * Only two values are needed because every app theme except `light` has a
 * dark rail; these approximate `--rail-foreground` in apps/main/global.css.
 */
const OVERLAY_COLOR = '#00000000';
const OVERLAY_SYMBOL_COLOR: Record<WindowColorScheme, string> = {
	light: '#57627a',
	dark: '#b3b7c0',
};

export function isWindowColorScheme(value: unknown): value is WindowColorScheme {
	return value === 'light' || value === 'dark';
}

export function titleBarOptions(
	scheme: WindowColorScheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
): BrowserWindowConstructorOptions {
	return {
		titleBarStyle: 'hidden',
		titleBarOverlay: {
			height: TITLE_BAR_HEIGHT,
			color: OVERLAY_COLOR,
			symbolColor: OVERLAY_SYMBOL_COLOR[scheme],
		},
		trafficLightPosition: TRAFFIC_LIGHT_POSITION,
		// Windows/Linux: the overlay leaves no room for a menu bar; Alt still reveals it
		// and every accelerator keeps working.
		autoHideMenuBar: true,
	};
}

/**
 * Renderer → main on every theme change. `setTitleBarOverlay` exists only where
 * the overlay is drawn by Chromium (Windows/Linux); macOS paints its own buttons.
 */
export function applyWindowColorScheme(window: BrowserWindow, scheme: WindowColorScheme): void {
	if (process.platform === 'darwin' || window.isDestroyed()) return;
	window.setTitleBarOverlay({
		height: TITLE_BAR_HEIGHT,
		color: OVERLAY_COLOR,
		symbolColor: OVERLAY_SYMBOL_COLOR[scheme],
	});
}
