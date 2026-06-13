# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.5] - 2026-06-13

### Added
- Serial printing path for OS-paired Bluetooth Classic printers, with `serialport` transitive dependencies packaged into the app

### Fixed
- Use a single persistent Bluetooth chooser reply listener per window to avoid duplicate device prompts
- Guard against ghost print jobs firing after a print timeout

### Changed
- Linux `.deb`/`.rpm` publishing is decoupled from Flatpak, so Linux packages ship even when the Flatpak maker fails (Flatpak is now opt-in via `WCPOS_FLATPAK=1`)
- Flathub submission assets finalized against the v1.9.4 `.deb`, with a `Flathub Validate` CI workflow proving the install path
- Includes the [WCPOS app v1.9.4](https://github.com/wcpos/monorepo/releases/tag/v1.9.4) updates — redesigned Bluetooth printer setup, serial printing, Windows print-spooler routing, USB printer flow improvements, and network print fixes
- Updated bundled translations to 2026.6.4

### Platforms
- macOS Intel, macOS Apple Silicon, Windows, and Linux (`.deb`/`.rpm`) assets are published in this release
- Flatpak/Flathub remains a separate, in-progress submission

## [1.9.4] - 2026-06-12

### Fixed
- Windows raw USB printing now routes through the print spooler instead of writing directly to the USB device

### Changed
- Updated bundled translations to version 2026.6.2
- Bumped in-range dependency floors

## [1.9.3] - 2026-06-09

### Fixed
- Startup failure after updating to v1.9.2 caused by the packaged app missing the runtime `usb` module
- Packaged app now includes `usb` and `node-gyp-build` so raw USB receipt printer support loads after install/update

## [1.9.2] - 2026-06-09

### Changed
- Includes the WCPOS 1.9.2 app updates (Star Online cloud printing, redesigned printer settings, product sorting, server-side PDF receipts)
- Flathub placeholder validation downgraded to a warning so it no longer blocks publishing
- Linux native module rebuilds use C++17 flags

## [1.9.1] - 2026-05-19

### Changed
- Updated bundled translations to version 2026.5.13

## [1.9.0] - 2026-05-15

### Added
- Raw TCP print handler for ESC/POS network printers
- RxDB v17 IPC storage bridge with image-cache protocol
- Configurable Expo dev port via `EXPO_PORT` env var
- Dev-mode HTTP response logging for debugging

### Changed
- Upgraded to Electron 41 (with better-sqlite3 compatibility workaround)
- Upgraded better-sqlite3 to 12.10.0
- Upgraded RxDB to 17.x
- Bumped axios for security fixes
- Bumped pnpm to 10.31.0

### Fixed
- EPIPE errors and crashes during dev startup
- `clearAllDatabases` now also wipes filesystem-node storage
- `electron-rebuild` skips eccrypto on arm64
- Silenced noisy rxdb-premium version check in main process
- Image cache no longer copies response body unnecessarily
