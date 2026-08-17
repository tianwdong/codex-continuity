import { access, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const STALE_LOCK_MS = 120_000;

function environmentValue(environment, name, platform) {
  if (environment[name] !== undefined) return environment[name];
  if (platform !== "win32") return undefined;
  const entry = Object.entries(environment)
    .find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

export function pluginDataDirectory({
  environment = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const explicitDirectory = environmentValue(environment, "CODEX_CONTINUITY_DATA", platform);
  if (explicitDirectory) return explicitDirectory;
  if (platform === "win32") {
    const localData = environmentValue(environment, "LOCALAPPDATA", platform)
      || environmentValue(environment, "APPDATA", platform)
      || pathApi.join(homeDirectory, "AppData", "Local");
    return pathApi.join(localData, "Codex Continuity Plugin");
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Codex Continuity Plugin");
  }
  const stateDirectory = environmentValue(environment, "XDG_STATE_HOME", platform)
    || path.join(homeDirectory, ".local", "state");
  return path.join(stateDirectory, "codex-continuity-plugin");
}

export function threadStateCoordinate(dataDirectory, threadId) {
  const digest = createHash("sha256").update(String(threadId || "")).digest("hex");
  return {
    statePath: path.join(dataDirectory, "title-state", `${digest}.json`),
    progressPath: path.join(dataDirectory, "progress-state", `${digest}.json`),
    promptSeenPath: path.join(dataDirectory, "prompt-seen-state", `${digest}.json`),
    promptCheckPath: path.join(dataDirectory, "prompt-check-state", `${digest}.json`),
    nativeTitleTurnPath: path.join(dataDirectory, "native-title-turn", `${digest}.json`),
    lockPath: path.join(dataDirectory, "locks", `${digest}.lock`),
  };
}

export async function acquireThreadLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const tryOpen = async () => {
    const handle = await open(lockPath, "wx", 0o600);
    const identity = randomUUID();
    try {
      await handle.writeFile(identity, "utf8");
      return { handle, identity };
    } catch (error) {
      await handle.close();
      try {
        await unlink(lockPath);
      } catch (_) {}
      throw error;
    }
  };
  try {
    return await tryOpen();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs <= STALE_LOCK_MS) return null;
      await unlink(lockPath);
      return await tryOpen();
    } catch (retryError) {
      if (["ENOENT", "EEXIST"].includes(retryError?.code)) return null;
      throw retryError;
    }
  }
}

export async function releaseThreadLock(lockPath, handle) {
  const fileHandle = handle?.handle ?? handle;
  const identity = handle?.identity ?? fileHandle?.lockIdentity ?? "";
  let owned = false;
  try {
    if (!identity) return;
    let currentIdentity;
    try {
      currentIdentity = (await readFile(lockPath, "utf8")).trim();
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (currentIdentity !== identity) return;

    const currentStat = await stat(lockPath);
    const ownedStat = await fileHandle?.stat();
    if (!ownedStat
      || currentStat.dev !== ownedStat.dev
      || currentStat.ino !== ownedStat.ino) return;
    owned = true;
  } finally {
    await fileHandle?.close();
  }
  if (!owned) return;
  try {
    if ((await readFile(lockPath, "utf8")).trim() !== identity) return;
    await unlink(lockPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function codexExecutableCandidates({
  environment = process.env,
  platform = process.platform,
  homeDirectory = os.homedir(),
  nodeExecutable = process.execPath,
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path;
  const executableName = platform === "win32" ? "codex.exe" : "codex";
  const candidates = [];
  const explicitCommand = environmentValue(environment, "CODEX_CONTINUITY_CODEX", platform);
  if (explicitCommand) candidates.push(explicitCommand);
  const bundledNode = nodeExecutable
    && nodeExecutable.toLowerCase().includes(`${pathApi.sep}cua_node${pathApi.sep}`);
  if (nodeExecutable && (platform === "win32" || bundledNode)) {
    const nodeDirectory = pathApi.dirname(nodeExecutable);
    candidates.push(
      pathApi.resolve(nodeDirectory, "..", "..", executableName),
      pathApi.join(nodeDirectory, executableName),
    );
  }
  if (platform === "darwin") {
    candidates.push(
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(homeDirectory, "Applications/Codex.app/Contents/Resources/codex"),
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      path.join(homeDirectory, "Applications/ChatGPT.app/Contents/Resources/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    );
  }
  if (nodeExecutable && platform !== "win32" && !bundledNode) {
    candidates.push(pathApi.join(pathApi.dirname(nodeExecutable), executableName));
  }
  const searchPath = environmentValue(environment, "PATH", platform) || "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const directory of searchPath.split(delimiter).filter(Boolean)) {
    candidates.push(pathApi.join(directory, executableName));
  }
  return [...new Set(candidates)];
}

export async function resolveCodexExecutable(options = {}) {
  const accessImpl = options.accessImpl || access;
  const candidates = codexExecutableCandidates(options);
  for (const candidate of candidates) {
    try {
      await accessImpl(candidate);
      return candidate;
    } catch (_) {}
  }
  throw new Error("codex_runtime_unavailable");
}

export function childEnvironment() {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_INSPECTOR_IPC;
  delete environment.CODEX_THREAD_ID;
  return environment;
}

export function semanticEnvironment(environment = process.env, platform = process.platform) {
  const keys = [
    "HOME",
    "USERPROFILE",
    "PATH",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LOCALAPPDATA",
    "APPDATA",
    "SYSTEMROOT",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
  ];
  return Object.fromEntries(
    keys
      .map((key) => [key, environmentValue(environment, key, platform)])
      .filter(([, value]) => value !== undefined),
  );
}
