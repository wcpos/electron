# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
