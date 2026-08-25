/**
 * Smoke-test a PACKAGED build: can the app actually talk to a server?
 *
 * Why this exists
 * ---------------
 * 1.10.1 shipped with every HTTP request dead. The preload gates each invoke on
 * INVOKE_CHANNELS; #354 renamed the transport channel 'axios' -> 'http-request'
 * in main, but this repo's vendored copy of the channel registry kept the old
 * name. Main served 'http-request', the preload permitted 'axios', and the
 * renderer's own guard rejected the call BEFORE IPC — so nothing reached the
 * main process and nothing appeared in the transport log.
 *
 * Every source-level test passed, in both repos, because the defect did not
 * exist in source. The renderer picks the channel name in the monorepo; the
 * preload enforces the allowlist here. No type system spans that seam, and the
 * only place both halves meet is the packaged artifact.
 *
 * So this test asserts the one thing that matters end to end — a real HTTP
 * request, through the real preload, over the real IPC bridge, in the real
 * built app — against a local server, so it needs no network and cannot flake
 * on someone else's uptime.
 *
 * Usage: node scripts/smoke-packaged-app.mjs <path-to-.app-or-executable>
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const MARKER = "wcpos-smoke-ok";
const CDP_PORT = 9412;
const BOOT_TIMEOUT_MS = 60_000;

const fail = (msg) => {
  console.error(`\nSMOKE FAILED: ${msg}\n`);
  process.exit(1);
};

/** Resolve a .app bundle (or a directory containing one) to its executable. */
function resolveExecutable(target) {
  if (!target)
    fail("usage: node scripts/smoke-packaged-app.mjs <path-to-.app>");
  if (!fs.existsSync(target)) fail(`no such path: ${target}`);
  if (fs.statSync(target).isFile()) return target;

  // electron-forge packages to out/<name>-<platform>-<arch>/<name>.app, so accept
  // either the bundle itself or a directory above it. Collect ALL matches and
  // refuse to guess: silently picking the first bundle is how you end up smoke
  // testing something that isn't the app you just built.
  const collectBundles = (dir, depth = 0, acc = []) => {
    if (depth > 3) return acc;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.endsWith(".app")) acc.push(full);
      else collectBundles(full, depth + 1, acc);
    }
    return acc;
  };

  // A bundle passed directly is the answer — never search inside it, or the
  // Helper (Renderer)/GPU/Plugin bundles under Contents/Frameworks look like hits.
  if (target.endsWith(".app")) {
    const macosDir = path.join(target, "Contents", "MacOS");
    const [binary] = fs.readdirSync(macosDir);
    if (!binary) fail(`no executable in ${macosDir}`);
    return path.join(macosDir, binary);
  }

  const bundles = collectBundles(target);
  if (bundles.length === 0) fail(`no .app bundle under ${target}`);
  if (bundles.length > 1) {
    fail(
      `found ${bundles.length} .app bundles under ${target}; pass one explicitly:\n  ` +
        bundles.join("\n  "),
    );
  }
  const appDir = bundles[0];

  const macos = path.join(appDir, "Contents", "MacOS");
  const [bin] = fs.readdirSync(macos);
  if (!bin) fail(`no executable in ${macos}`);
  return path.join(macos, bin);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl,
      );
      if (page) return page;
    } catch {
      // devtools endpoint not up yet
    }
    await sleep(500);
  }
  return null;
}

/** Evaluate an expression in the renderer and return its value. */
async function evaluate(page, expression) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("could not attach to the renderer"));
    });
    const call = (id, method, params) =>
      new Promise((res) => {
        const onMessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id === id) {
            ws.removeEventListener("message", onMessage);
            res(msg);
          }
        };
        ws.addEventListener("message", onMessage);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await call(1, "Runtime.enable", {});
    const result = await call(2, "Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.result?.result?.value;
  } finally {
    ws.close();
  }
}

async function main() {
  const executable = resolveExecutable(process.argv[2]);
  console.log(`smoke: ${executable}`);

  // A local origin, so the test proves the transport works without depending on
  // anyone else's server being up.
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ marker: MARKER }));
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // A throwaway profile: a smoke test must not read or write the real store.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wcpos-smoke-"));

  const child = spawn(
    executable,
    [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${userDataDir}`],
    { stdio: "ignore", detached: false },
  );
  child.on("error", (err) => fail(`could not launch the app: ${err.message}`));

  try {
    const page = await findPageTarget(Date.now() + BOOT_TIMEOUT_MS);
    if (!page)
      fail(`the app did not open a renderer within ${BOOT_TIMEOUT_MS}ms`);

    const bridgeShape = await evaluate(
      page,
      "typeof window.ipcRenderer + '/' + typeof (window.ipcRenderer||{}).invoke",
    );
    if (bridgeShape !== "object/function") {
      fail(
        `the preload did not expose an ipcRenderer.invoke bridge (saw ${bridgeShape})`,
      );
    }

    const outcome = await evaluate(
      page,
      `window.ipcRenderer.invoke('http-request', {
				type: 'request',
				requestId: 'smoke',
				config: { url: ${JSON.stringify(origin)}, method: 'get', timeout: 15000 },
			}).then(r => 'OK:' + r.status + ':' + JSON.stringify(r.data))
			  .catch(e => 'ERR:' + e.message)`,
    );

    if (typeof outcome !== "string")
      fail(`unreadable result from the renderer: ${outcome}`);

    if (outcome.startsWith("ERR:")) {
      // The 1.10.1 shape. Name it explicitly — this is the whole point of the test.
      if (/is not allowed/.test(outcome)) {
        fail(
          `the preload rejected the transport channel: ${outcome}\n` +
            "  Main serves this channel but the preload allowlist does not permit it.\n" +
            "  The handlers and INVOKE_CHANNELS have drifted apart — they ship as one\n" +
            "  artifact, so they must agree.",
        );
      }
      fail(`the packaged app could not complete an HTTP request: ${outcome}`);
    }

    if (!outcome.includes(MARKER)) fail(`unexpected response body: ${outcome}`);

    console.log(`smoke: HTTP over the IPC bridge -> ${outcome}`);
    console.log("SMOKE-COMPLETE: the packaged app can reach a server");
  } finally {
    child.kill("SIGKILL");
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
