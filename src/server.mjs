import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prototypeRoot = path.join(projectRoot, "prototype");
const files = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
]);

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

export async function startContinuityServer({ host = "127.0.0.1", port = 0 } = {}) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}`;
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "Method not allowed", { allow: "GET, HEAD" });
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    if (requestUrl.pathname === `${prefix}/health`) {
      send(response, 200, request.method === "HEAD" ? "" : "ok", {
        "content-type": "text/plain; charset=utf-8",
      });
      return;
    }
    if (!requestUrl.pathname.startsWith(`${prefix}/`)) {
      send(response, 404, "Not found");
      return;
    }

    const relativePath = requestUrl.pathname.slice(prefix.length) || "/";
    const asset = files.get(relativePath);
    if (!asset) {
      send(response, 404, "Not found");
      return;
    }

    try {
      const body = request.method === "HEAD"
        ? ""
        : await readFile(path.join(prototypeRoot, asset.name));
      send(response, 200, body, { "content-type": asset.type });
    } catch (error) {
      console.error(`Continuity asset failed: ${error.message}`);
      send(response, 500, "Asset unavailable");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Continuity server did not expose a TCP address");
  }
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    baseUrl: `${origin}${prefix}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function main() {
  const runtime = await startContinuityServer({ port: 4173 });
  console.log(`Continuity prototype: ${runtime.baseUrl}`);
  const stop = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
