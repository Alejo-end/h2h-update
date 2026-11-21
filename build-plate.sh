#!/bin/zsh
# Takes the plate drawing and the firmware light model from the H2H site
# (h2h-site/src/diagram.ts and h2h.ts) and bundles them into js/plate.js, so this
# page shows the board the same way the site does. Run it again after the site
# changes them. It also copies the maze picture, the logo and the Figtree font.
set -e
HERE=${0:A:h}
SITE=${H2H_SITE:-$HERE/../../../../h2h-site}
SITE=${SITE:A}
[[ -f $SITE/src/diagram.ts ]] || { echo "h2h-site not found at $SITE (set H2H_SITE)"; exit 1; }
"$SITE/node_modules/.bin/esbuild" --bundle --format=esm --target=es2020 --minify \
  --define:import.meta.env.BASE_URL='""' \
  --outfile="$HERE/js/plate.js" /dev/stdin <<JS
export { Diagram } from "$SITE/src/diagram.ts";
export { h2h } from "$SITE/src/h2h.ts";
JS
cp "$SITE/public/plate-maze.webp" "$HERE/plate-maze.webp"
cp "$SITE/public/h2h-logo.svg" "$HERE/img/h2h-logo.svg"
mkdir -p "$HERE/fonts"
cp "$SITE/node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2" "$HERE/fonts/"
cp "$SITE/node_modules/@fontsource-variable/figtree/files/figtree-latin-ext-wght-normal.woff2" "$HERE/fonts/"
echo "js/plate.js from $SITE"
