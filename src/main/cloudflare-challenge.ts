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
// Cashier-facing budget once the window has been shown.
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

export type CookieLike = { name: string; value: string };

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
		return (await deps.getCookies(url)).filter((cookie) => CLOUDFLARE_COOKIE.test(cookie.name));
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
		const before = await clearanceValue(url);
		const win = deps.createWindow(host);
		let closed = false;
		let finishedLoads = 0;
		let shown = false;
		win.once('closed', () => {
			closed = true;
		});
		win.webContents.once('did-finish-load', () => {
			finishedLoads += 1;
		});
		const started = Date.now();
		try {
			// A challenge page navigates itself once solved, which can reject the
			// original loadURL promise; the poll below is the source of truth.
			win.loadURL(url).catch((): void => undefined);
			while (!closed) {
				const elapsed = Date.now() - started;
				const value = await clearanceValue(url);
				const minted = Boolean(value) && value !== before;
				const settled =
					finishedLoads > 0 &&
					!win.webContents.isLoading() &&
					!CHALLENGE_TITLE.test(win.webContents.getTitle());
				if (minted || (settled && Boolean(value))) {
					if (!settled) await sleep(settleMs);
					logger.info('Cloudflare challenge cleared', {
						host,
						interactive: shown,
						ms: Date.now() - started,
					});
					return true;
				}
				if (!shown && elapsed >= silentSolveMs) {
					shown = true;
					logger.warn('Cloudflare challenge needs the cashier; showing it', { host });
					win.show();
				}
				if (elapsed >= interactiveSolveMs) {
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
			if (!closed && !win.isDestroyed()) win.close();
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

function defaultDeps(): ChallengeDeps {
	return {
		// Filter by host, not url: cookies.get({ url }) misses a cf_clearance whose
		// domain is the parent (.example.com) — measured on Electron 42, the
		// domain filter returns it.
		getCookies: (url) =>
			session.fromPartition(CHALLENGE_PARTITION).cookies.get({ domain: new URL(url).host }),
		createWindow: (host) =>
			new BrowserWindow({
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
			}),
	};
}

let defaultClearer: ChallengeClearer | undefined;

// Lazy: touching session/BrowserWindow before app ready throws, and the bridge
// registers its IPC handler at module load.
export function getDefaultChallengeClearer(): ChallengeClearer {
	if (!defaultClearer) defaultClearer = createChallengeClearer(defaultDeps());
	return defaultClearer;
}
