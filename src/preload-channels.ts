/**
 * Invoke channels main serves ahead of their typed entry in @wcpos/printer's INVOKE_CHANNELS.
 * Each one names the companion PR that adds the typed entry; remove it once that lands.
 */
export const PRELOAD_EXTRA_INVOKE_CHANNELS = [
	'usb-query-model', // wcpos/monorepo#1884
] as const;
