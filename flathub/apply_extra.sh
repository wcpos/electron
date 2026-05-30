#!/bin/sh
# Runs at install time with the working directory set to /app/extra.
# Unpacks the prebuilt .deb and flattens the app payload into /app/extra so the
# launcher can exec /app/extra/WooCommercePOS.
set -e

ar x woocommerce-pos.deb
rm -f debian-binary control.tar.* woocommerce-pos.deb

# data.tar may be .xz, .gz or .zst depending on the dpkg version that built it.
tar xf data.tar.*
rm -f data.tar.*

# electron-installer-deb lays the app down under /usr/lib/<package-name>/.
# Confirm this path against a real .deb (`dpkg -c <file>.deb`) before submitting —
# the package name is derived from the productName ("woocommerce-pos").
mv usr/lib/woocommerce-pos/* .
rm -rf usr
