import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const hasIndex of [true, false]) {
  test(
    hasIndex
      ? "replaces dist with the renderer export"
      : "rejects an export without index.html",
    (t) => {
      const root = mkdtempSync(join(tmpdir(), "wcpos-import-renderer-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, "scripts"));
      copyFileSync(
        new URL("./import-renderer.mjs", import.meta.url),
        join(root, "scripts/import-renderer.mjs"),
      );
      mkdirSync(join(root, "export/assets"), { recursive: true });
      writeFileSync(join(root, "export/assets/app.js"), "renderer");
      if (hasIndex)
        writeFileSync(join(root, "export/index.html"), "<html>renderer</html>");
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "dist/stale.txt"), "old");

      const result = spawnSync(
        process.execPath,
        [join(root, "scripts/import-renderer.mjs"), "export"],
        { cwd: root, encoding: "utf8" },
      );
      assert.equal(result.status, hasIndex ? 0 : 1, result.stderr);
      if (hasIndex) {
        assert.equal(
          readFileSync(join(root, "dist/index.html"), "utf8"),
          "<html>renderer</html>",
        );
        assert.equal(
          readFileSync(join(root, "dist/assets/app.js"), "utf8"),
          "renderer",
        );
        assert.equal(existsSync(join(root, "dist/stale.txt")), false);
      } else {
        assert.match(result.stderr, /index\.html/);
        assert.equal(result.stderr.trim().split("\n").length, 1);
        assert.equal(readFileSync(join(root, "dist/stale.txt"), "utf8"), "old");
      }
    },
  );
}

test("refuses to import dist/ over itself", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wcpos-import-renderer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    new URL("./import-renderer.mjs", import.meta.url),
    join(root, "scripts/import-renderer.mjs"),
  );
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.html"), "<html>current</html>");

  const result = spawnSync(
    process.execPath,
    [join(root, "scripts/import-renderer.mjs"), "dist"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /inside it/);
  assert.equal(
    readFileSync(join(root, "dist/index.html"), "utf8"),
    "<html>current</html>",
  );
});
