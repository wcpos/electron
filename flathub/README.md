# Flathub submission assets

This directory holds the files needed to publish **WCPOS** to
[Flathub](https://flathub.org). They are **not** built by Electron Forge — the
`maker-flatpak` in `forge.config.ts` produces a standalone `.flatpak` bundle for
direct download, whereas Flathub builds and hosts the app itself from a manifest.

## Why `extra-data` instead of building from source

Flathub normally builds apps from source. WCPOS can't be built on Flathub's
buildbot because it bundles the proprietary, license-key-gated `rxdb-premium` and
its renderer comes from a separate private monorepo. The accepted pattern for such
apps is `extra-data`: the manifest references the prebuilt `.deb` we already publish
to GitHub releases, and Flatpak downloads + unpacks it on the user's machine at
install time (`apply_extra.sh`). Be ready to explain this to Flathub reviewers.

## Files

| File | Purpose |
| --- | --- |
| `com.wcpos.main.yml` | The Flatpak manifest (the submission entrypoint). |
| `apply_extra.sh` | Unpacks the `.deb` into `/app/extra` at install time. |
| `wcpos.sh` | Launcher — runs the Electron binary via `zypak-wrapper`. |
| `com.wcpos.main.desktop` | Desktop entry. |
| `com.wcpos.main.metainfo.xml` | AppStream metadata (Flathub requires this). |
| `icon-256.png` | 256×256 app icon. |

## Before submitting — finalise the placeholders

Everything marked `TODO` must be resolved against a **real** built `.deb`. The
package name is `woocommerce-pos`, so the artifact is `woocommerce-pos_<version>_amd64.deb`:

1. **Build the `.deb`** (CI `publish-linux` job, or locally on Linux:
   `npm run rebuild:all && npx electron-forge make --targets @electron-forge/maker-deb`).
2. **Confirm the asset name** in `com.wcpos.main.yml` (`url:`) matches the published
   release asset.
3. **Fill `sha256` and `size`** of that `.deb`:
   `sha256sum woocommerce-pos_*_amd64.deb` and `stat -c %s` (or let
   [flatpak-external-data-checker](https://github.com/flathub/flatpak-external-data-checker)
   do it — `x-checker-data` is already wired up for per-release updates).
4. **Verify the internal layout** with `dpkg -c woocommerce-pos_*_amd64.deb` and fix
   the `usr/lib/woocommerce-pos/` path in `apply_extra.sh` if it differs.
5. **Confirm `StartupWMClass`** in the `.desktop` file with `xprop WM_CLASS` on a
   running build, so the window associates with the launcher.
6. **Add a real screenshot** URL in the metainfo — Flathub rejects without one.
7. **Confirm runtime/base versions** (`24.08`) are still the latest non-EOL branches.
8. **Verify the app id `com.wcpos.main`** (matches the other wcpos apps). Flathub
   requires verifying ownership via the wcpos.com domain or the GitHub org. Note that
   "WooCommerce" is an Automattic trademark — the app name is "WCPOS"; the only
   remaining references are nominative ("Point of Sale for WooCommerce"), describing
   compatibility.

## Submitting

Validate locally, then open a PR against
[`flathub/flathub`](https://github.com/flathub/flathub) (new-app submission flow):

```bash
# from a Linux machine with flatpak + flatpak-builder
flatpak install -y flathub org.flatpak.Builder
flatpak run org.flatpak.Builder --user --install --force-clean \
  --install-deps-from=flathub build-dir com.wcpos.main.yml
flatpak run org.flatpak.Builder --user --force-clean --sandbox \
  --run build-dir com.wcpos.main.yml wcpos
# lint the manifest + metadata the way Flathub CI does
flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest com.wcpos.main.yml
flatpak run --command=flatpak-builder-lint org.flatpak.Builder appstream com.wcpos.main.metainfo.xml
```

Once accepted, Flathub creates `flathub/com.wcpos.main` and hosts the app; this
directory is the source of truth to copy updates from.
