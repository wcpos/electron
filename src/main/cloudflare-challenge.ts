// Cloudflare "Just a moment…" challenges on main-process requests.
//
// Cloudflare's managed challenge (also Bot Fight Mode, Under Attack mode and
// Precursor's "Maximize Security") answers any request that carries no
// cf_clearance cookie with an HTML interstitial: HTTP 403 plus a
// `cf-mitigated: challenge` header. Only a browser can solve it, so every
// non-browser WordPress client (Node, curl, the mobile apps) is locked out and
// the app reported "Site does not seem to be a WordPress site". The main
// process IS a browser: a hidden BrowserWindow solves the non-interactive
// form silently — measured 2.5–3.3 s against a Free-plan store on 2026-09-10 —
// and receives cf_clearance for the merchant's configured passage (30 min by
// default, up to a year).
//
// Two measured constraints shape the design:
// 1. net.fetch from the main process does NOT send session cookies, even with
//    credentials: 'include' (Electron 42/43). The clearance must therefore be
//    attached as an explicit Cookie header, which net.fetch honours.
// 2. External pages must never run in the default session: the wcpos-image://
//    handler registered there is an SSRF read-proxy (see
//    external-window-isolation.test.ts). The challenge window lives in its own
//    persistent partition and the bridge reads Cloudflare's cookies from it.
// The clearance is bound to IP and user agent; the window and net.fetch share
// both, so a cookie minted by the window is valid for the bridge.

import { BrowserWindow, session } from 'electron';

import { logger } from './log';

export const CHALLENGE_PARTITION = 'persist:cloudflare-challenge';

// A non-interactive managed challenge clears well inside this. Past it, the
// challenge is interactive (a Turnstile checkbox) and needs the cashier.
export const SILENT_SOLVE_MS = 15_000;
// Cashier-facing budget, measured from the moment the window is shown.
export const INTERACTIVE_SOLVE_MS = 120_000;
// A failed solve must not reopen a window for every request queued behind it.
export const FAILURE_COOLDOWN_MS = 30_000;
const POLL_MS = 250;
// After the edge issues the cookie the page reloads once; give that reload a
// moment so the session state Cloudflare writes on it is not raced.
const SETTLE_MS = 2_000;
// Only Cloudflare's own cookies are forwarded (cf_clearance, __cf_bm, _cfuvid…).
// WordPress auth cookies must never ride along: a wordpress_logged_in cookie
// without a nonce makes the REST API reject every request.
const CLOUDFLARE_COOKIE = /^(cf_|__cf|_cf)/;
const CLEARANCE_COOKIE = 'cf_clearance';
const CHALLENGE_TITLE = /just a moment/i;

export function isChallengeResponse(headers: { get(name: string): string | null }): boolean {
	return (headers.get('cf-mitigated') || '').trim().toLowerCase() === 'challenge';
}

export type CookieLike = {
	name: string;
	value: string;
	// Scope metadata as Electron's cookies.get returns it. The header builder
	// applies normal cookie-matching rules with it, so a Secure clearance never
	// rides on a plaintext hop and a path- or host-scoped cookie stays scoped.
	domain?: string;
	path?: string;
	secure?: boolean;
	hostOnly?: boolean;
};

function cookieMatchesUrl(cookie: CookieLike, url: URL): boolean {
	if (cookie.secure && url.protocol !== 'https:') return false;
	const path = cookie.path || '/';
	if (!(url.pathname === path || url.pathname.startsWith(path.endsWith('/') ? path : `${path}/`)))
		return false;
	if (!cookie.domain) return true;
	const domain = cookie.domain.replace(/^\./, '');
	if (cookie.hostOnly) return url.hostname === domain;
	return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
}

export type ChallengeWindow = {
	loadURL(url: string): Promise<void>;
	show(): void;
	close(): void;
	isDestroyed(): boolean;
	once(event: 'closed', listener: () => void): unknown;
	webContents: {
		isLoading(): boolean;
		getTitle(): string;
		once(event: 'did-finish-load', listener: () => void): unknown;
	};
};

export type ChallengeDeps = {
	getCookies(url: string): Promise<CookieLike[]>;
	createWindow(host: string): ChallengeWindow;
	silentSolveMs?: number;
	interactiveSolveMs?: number;
	failureCooldownMs?: number;
	pollMs?: number;
	settleMs?: number;
};

export type ChallengeClearer = {
	/** Cloudflare cookies for this URL as a Cookie header value, or undefined. */
	cookieHeaderFor(url: string): Promise<string | undefined>;
	/** Solve the challenge for this URL's origin. Resolves true once cleared. */
	clear(url: string): Promise<boolean>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createChallengeClearer(deps: ChallengeDeps): ChallengeClearer {
	const silentSolveMs = deps.silentSolveMs ?? SILENT_SOLVE_MS;
	const interactiveSolveMs = deps.interactiveSolveMs ?? INTERACTIVE_SOLVE_MS;
	const failureCooldownMs = deps.failureCooldownMs ?? FAILURE_COOLDOWN_MS;
	const pollMs = deps.pollMs ?? POLL_MS;
	const settleMs = deps.settleMs ?? SETTLE_MS;
	// One window per origin at a time: a sync burst that hits the challenge
	// queues behind a single solve instead of opening a window per request.
	const inFlight = new Map<string, Promise<boolean>>();
	const failedAt = new Map<string, number>();

	async function cloudflareCookies(url: string): Promise<CookieLike[]> {
		const parsed = new URL(url);
		return (await deps.getCookies(url)).filter(
			(cookie) => CLOUDFLARE_COOKIE.test(cookie.name) && cookieMatchesUrl(cookie, parsed)
		);
	}

	async function cookieHeaderFor(url: string): Promise<string | undefined> {
		const cookies = await cloudflareCookies(url);
		if (cookies.length === 0) return undefined;
		return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
	}

	async function clearanceValue(url: string): Promise<string | undefined> {
		return (await deps.getCookies(url)).find((cookie) => cookie.name === CLEARANCE_COOKIE)?.value;
	}

	async function solve(url: string, host: string): Promise<boolean> {
		let win: ChallengeWindow | undefined;
		let closed = false;
		let finishedLoads = 0;
		let shownAt: number | undefined;
		const started = Date.now();
		try {
			// Everything, including the cookie lookup and window construction, is
			// guarded: clear() must resolve false so the bridge hands back the 403
			// challenge it already holds instead of a bare ERR_NETWORK.
			const before = await clearanceValue(url);
			win = deps.createWindow(host);
			const window = win;
			window.once('closed', () => {
				closed = true;
			});
			window.webContents.once('did-finish-load', () => {
				finishedLoads += 1;
			});
			// A challenge page navigates itself once solved, which can reject the
			// original loadURL promise; the poll below is the source of truth.
			window.loadURL(url).catch((): void => undefined);
			while (!closed) {
				const elapsed = Date.now() - started;
				const value = await clearanceValue(url);
				const minted = Boolean(value) && value !== before;
				const settled =
					finishedLoads > 0 &&
					!window.webContents.isLoading() &&
					!CHALLENGE_TITLE.test(window.webContents.getTitle());
				if (minted || (settled && Boolean(value))) {
					if (!settled) await sleep(settleMs);
					logger.info('Cloudflare challenge cleared', {
						host,
						interactive: shownAt !== undefined,
						ms: Date.now() - started,
					});
					return true;
				}
				if (shownAt === undefined && elapsed >= silentSolveMs) {
					shownAt = Date.now();
					logger.warn('Cloudflare challenge needs the cashier; showing it', { host });
					window.show();
				}
				if (shownAt !== undefined && Date.now() - shownAt >= interactiveSolveMs) {
					logger.warn('Cloudflare challenge not cleared in time', { host });
					return false;
				}
				await sleep(pollMs);
			}
			logger.warn('Cloudflare challenge window closed before clearing', { host });
			return false;
		} catch (error) {
			logger.error('Cloudflare challenge solve failed', {
				host,
				message: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			if (win && !closed && !win.isDestroyed()) win.close();
		}
	}

	async function clear(url: string): Promise<boolean> {
		let origin: string;
		let host: string;
		try {
			const parsed = new URL(url);
			origin = parsed.origin;
			host = parsed.host;
		} catch {
			return false;
		}
		const pending = inFlight.get(origin);
		if (pending) return pending;
		const lastFailure = failedAt.get(origin);
		if (lastFailure !== undefined && Date.now() - lastFailure < failureCooldownMs) return false;
		const attempt = solve(url, host)
			.then((cleared) => {
				if (cleared) failedAt.delete(origin);
				else failedAt.set(origin, Date.now());
				return cleared;
			})
			.finally(() => {
				inFlight.delete(origin);
			});
		inFlight.set(origin, attempt);
		return attempt;
	}

	return { cookieHeaderFor, clear };
}

let hardened = false;

// The partition hosts a page the store controls. Isolation from the default
// session keeps wcpos-image:// out of its reach; this keeps the camera,
// microphone, location and devices out of it too — Electron's default request
// handler would otherwise grant getUserMedia to a hidden window.
function challengeSession() {
	const ses = session.fromPartition(CHALLENGE_PARTITION);
	if (!hardened) {
		ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		ses.setPermissionCheckHandler(() => false);
		ses.setDevicePermissionHandler(() => false);
		hardened = true;
	}
	return ses;
}

function defaultDeps(): ChallengeDeps {
	return {
		// Filter by hostname, not url: cookies.get({ url }) misses a cf_clearance
		// whose domain is the parent (.example.com) — measured on Electron 42, the
		// domain filter returns it. hostname, not host: cookie domains carry no port.
		getCookies: (url) => challengeSession().cookies.get({ domain: new URL(url).hostname }),
		createWindow: (host) => {
			challengeSession();
			const win = new BrowserWindow({
				show: false,
				width: 520,
				height: 640,
				title: `Security check for ${host}`,
				autoHideMenuBar: true,
				webPreferences: {
					nodeIntegration: false,
					contextIsolation: true,
					sandbox: true,
					partition: CHALLENGE_PARTITION,
				},
			});
			// The page would otherwise retitle the window ("Just a moment…"); the
			// cashier should see which store is asking, not the page's own words.
			win.on('page-title-updated', (event) => event.preventDefault());
			return win;
		},
	};
}

let defaultClearer: ChallengeClearer | undefined;

// Lazy: touching session/BrowserWindow before app ready throws, and the bridge
// registers its IPC handler at module load.
export function getDefaultChallengeClearer(): ChallengeClearer {
	if (!defaultClearer) defaultClearer = createChallengeClearer(defaultDeps());
	return defaultClearer;
}
