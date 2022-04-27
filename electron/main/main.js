import { checkForUpdates } from './update';
import { registerMenu } from './menu';
import { initProtocolHandling } from './protocol';

/**
 * This function is executed at the earliest possible moment in the app lifecycle.
 * It should configure critical elements which are needed prior to the creation of the main window.
 */
//  export const prepare = () => {
//   enableLogging()
//   enableCrashReports(isReportErrorsEnabled)
//   setErrorReportingId()
// }

/**
 * This function is executed once the app's main window has been instantiated and handles
 * any remaining setup of the application.
 */
export const main = () => {
	checkForUpdates();
	initProtocolHandling();
	// configHandlers.register(null);
	// globalHandlers.register(null);
	// launcherHandlers.register(null);
	registerMenu();
};
