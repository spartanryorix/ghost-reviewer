// Zero-dependency local server: serves the static app and the /api functions.
// Usage: put NVIDIA_API_KEY in .env, then `node server.js` and open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
loadEnv(path.join(ROOT, ".env"));

const routes = {
  "/api/analyze": require("./api/analyze.js"),
  "/api/health": require("./api/health.js"),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const PORT = Number(process.env.PORT) || 3000;

http
  .createServer(async (req, res) => {
    addVercelStyleHelpers(res);
    const url = new URL(req.url, "http://localhost");

    const route = routes[url.pathname];
    if (route) {
      if (req.method === "POST") {
        try {
          req.body = await readJson(req);
        } catch (err) {
          return res.status(err.status || 400).json({ error: err.message });
        }
      }
      return route(req, res);
    }

    if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).end();
    serveStatic(url.pathname, res);
  })
  .listen(PORT, () => {
    const hasKey = Boolean(process.env.NVIDIA_API_KEY || process.env.LLM_API_KEY);
    console.log(`Ghost Reviewer on http://localhost:${PORT}`);
    if (!hasKey) console.warn("Warning: NVIDIA_API_KEY is not set (add it to .env). /api/analyze will fail.");
  });

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  // Never serve dotfiles (.env holds the key).
  if (rel.split("/").some((seg) => seg.startsWith("."))) return res.status(404).end("Not found");
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep)) return res.status(403).end();
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return res.status(404).end("Not found");
  fs.readFile(file, (err, buf) => {
    if (err) return res.status(404).end("Not found");
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(buf);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Body too large."), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

// Vercel gives handlers res.status().json(); mirror that so api/*.js runs unchanged.
function addVercelStyleHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
    return res;
  };
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
