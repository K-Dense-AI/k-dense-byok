import http from "node:http";

// Inherited by Pi's detached Node runners. A dead launcher must not leave an
// orphan spending tokens. Native Windows jobs additionally contain shell trees.
if (process.env.KADY_PACKAGED === "1" && process.env.KADY_CONTROL_URL) {
  const url = new URL("/status", process.env.KADY_CONTROL_URL);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid Kady supervisor address");
  let misses = 0;
  let pending = false;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.error("Kady supervisor stopped; shutting down owned worker.");
    // Emitting lets the backend flush accounting on Windows too. A worker
    // without a signal handler can exit immediately; the launcher owns its tree.
    if (!process.emit("SIGTERM")) process.exit(0);
    setTimeout(() => process.exit(1), 9000).unref();
  };
  const check = () => {
    if (pending) return;
    pending = true;
    const req = http.get(url, { headers: { "X-Kady-Token": process.env.KADY_AUTH_TOKEN }, timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", bytes => { body = (body + bytes).slice(0, 8192); });
      res.on("end", () => {
        finish(res.statusCode === 200);
        try { if (JSON.parse(body).stopping) stop(); } catch { /* Count failures via status. */ }
      });
      res.on("error", () => finish(false));
    });
    let finished = false;
    const finish = (ok) => { if (finished) return; finished = true; pending = false; misses = ok ? 0 : misses + 1;
      if (misses >= 3) stop();
    };
    req.on("timeout", () => req.destroy());
    req.on("error", () => finish(false));
  };
  const timer = setInterval(check, 2000); timer.unref();
}
