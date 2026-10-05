// The update server serves .deb or .rpm only when told which format is installed.
// AppImage and Flatpak report nothing.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export type LinuxPackageFormat = 'deb' | 'rpm';

export interface PackageFormatProbe {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	exists: (filePath: string) => boolean;
	rpmHasPackage: (name: string) => Promise<boolean>;
}

export const LINUX_PACKAGE_NAME = 'woocommerce-pos';

const defaultProbe: PackageFormatProbe = {
	platform: process.platform,
	env: process.env,
	exists: existsSync,
	rpmHasPackage: (name) =>
		new Promise((resolve) => {
			execFile('rpm', ['-q', '--quiet', name], { timeout: 5000 }, (error) => resolve(!error));
		}),
};

export async function detectLinuxPackageFormat(
	probe: PackageFormatProbe = defaultProbe
): Promise<LinuxPackageFormat | undefined> {
	try {
		if (probe.platform !== 'linux' || probe.env.APPIMAGE || probe.env.FLATPAK_ID) return undefined;
		if (
			probe.exists('/var/lib/dpkg/info/woocommerce-pos.list') ||
			probe.exists('/var/lib/dpkg/info/woocommerce-pos:amd64.list')
		) {
			return 'deb';
		}
		if (await probe.rpmHasPackage(LINUX_PACKAGE_NAME)) return 'rpm';
		return undefined;
	} catch {
		return undefined;
	}
}
