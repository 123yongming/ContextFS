import fs from "node:fs/promises";
import path from "node:path";

const FILES = {
  manifest: "manifest.md",
  pins: "pins.md",
  summary: "summary.md",
  decisions: "decisions.md",
  tasks: path.join("tasks", "current.md"),
  history: "history.ndjson",
  state: "state.json",
};

function nowIso() {
  return new Date().toISOString();
}

function safeTrim(text) {
  return String(text || "").trim();
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTmpPath(target) {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${target}.${process.pid}.${Date.now()}.${rand}.tmp`;
}

export class ContextFsStorage {
  constructor(workspaceDir, config) {
    this.workspaceDir = workspaceDir;
    this.config = config;
    this.baseDir = path.join(workspaceDir, config.contextfsDir);
    this.lockPath = path.join(this.baseDir, ".lock");
  }

  resolve(name) {
    return path.join(this.baseDir, FILES[name] || name);
  }

  async ensureInitialized() {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.mkdir(path.join(this.baseDir, "tasks"), { recursive: true });

    await this.ensureFile("manifest", this.defaultManifest());
    await this.ensureFile("pins", this.defaultPins());
    await this.ensureFile("summary", this.defaultSummary());
    await this.ensureFile("decisions", this.defaultDecisions());
    await this.ensureFile("tasks", this.defaultTask());
    await this.ensureFile("history", "");
    await this.ensureFile("state", JSON.stringify(this.defaultState(), null, 2) + "\n");

    await this.refreshManifest();
  }

  async ensureFile(name, fallback) {
    const filePath = this.resolve(name);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, fallback, "utf8");
    }
  }

  async acquireLock(maxRetries = 20) {
    for (let i = 0; i <= maxRetries; i += 1) {
      const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      try {
        await fs.writeFile(this.lockPath, stamp, { encoding: "utf8", flag: "wx" });
        return stamp;
      } catch (err) {
        if (err?.code !== "EEXIST") {
          throw err;
        }
        if (i === maxRetries) {
          throw new Error(`contextfs lock timeout: ${this.lockPath}`);
        }
        const jitterMs = 10 + Math.floor(Math.random() * 21);
        await sleepMs(jitterMs);
      }
    }
    throw new Error(`contextfs lock timeout: ${this.lockPath}`);
  }

  async releaseLock(stamp) {
    if (!stamp) {
      return;
    }
    try {
      const content = await fs.readFile(this.lockPath, "utf8");
      if (safeTrim(content) === stamp) {
        await fs.unlink(this.lockPath);
      }
    } catch {
      // ignore
    }
  }

  async writeTextWithLock(name, content) {
    const target = this.resolve(name);
    const tmp = makeTmpPath(target);
    try {
      await fs.writeFile(tmp, content, "utf8");
      await fs.rename(tmp, target);
    } finally {
      try {
        await fs.unlink(tmp);
      } catch {
        // ignore
      }
    }
  }

  async readText(name) {
    return fs.readFile(this.resolve(name), "utf8");
  }

  async writeText(name, content) {
    const lock = await this.acquireLock();
    try {
      await this.writeTextWithLock(name, content);
    } finally {
      await this.releaseLock(lock);
    }
  }

  async readState() {
    const raw = await this.readText("state");
    return JSON.parse(raw);
  }

  async updateState(patch) {
    const current = await this.readState();
    const next = {
      ...current,
      ...patch,
      revision: (current.revision || 0) + 1,
      updatedAt: nowIso(),
    };
    await this.writeText("state", JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  async readHistory() {
    const raw = await this.readText("history");
    if (!safeTrim(raw)) {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => safeTrim(line))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  async writeHistory(items) {
    const lines = items.map((item) => JSON.stringify(item)).join("\n");
    await this.writeText("history", lines ? `${lines}\n` : "");
  }

  async appendHistory(entry) {
    const lock = await this.acquireLock();
    try {
      const raw = await this.readText("history");
      const history = !safeTrim(raw)
        ? []
        : raw
            .split("\n")
            .filter((line) => safeTrim(line))
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
      history.push(entry);
      const lines = history.map((item) => JSON.stringify(item)).join("\n");
      await this.writeTextWithLock("history", lines ? `${lines}\n` : "");
      return history;
    } finally {
      await this.releaseLock(lock);
    }
  }

  async refreshManifest() {
    const now = nowIso();
    const state = await this.readState();
    const lines = [
      "# ContextFS Manifest",
      "",
      `- updated: ${now}`,
      `- revision: ${state.revision || 0}`,
      "",
      "## files",
      "- pins.md | key constraints and prohibitions | tags: pins,policy",
      "- summary.md | rolling compact summary | tags: memory,compact",
      "- decisions.md | long-form decisions and rationale | tags: decision,log",
      "- tasks/current.md | current task status | tags: task,short",
      "- history.ndjson | compactable turn history | tags: runtime,history",
      "",
      "## mode",
      `- autoInject: ${String(this.config.autoInject)}`,
      `- autoCompact: ${String(this.config.autoCompact)}`,
      `- recentTurns: ${this.config.recentTurns}`,
      `- tokenThreshold: ${this.config.tokenThreshold}`,
      `- pinsMaxItems: ${this.config.pinsMaxItems}`,
      `- summaryMaxChars: ${this.config.summaryMaxChars}`,
    ];
    await this.writeText("manifest", lines.slice(0, this.config.manifestMaxLines).join("\n") + "\n");
  }

  defaultManifest() {
    return "# ContextFS Manifest\n\n- updated: pending\n- revision: 0\n\n## files\n- pins.md\n- summary.md\n- decisions.md\n- tasks/current.md\n";
  }

  defaultPins() {
    return "# Pins (short, one line each)\n\n";
  }

  defaultSummary() {
    return "# Rolling Summary\n\n- init: no summary yet.\n";
  }

  defaultDecisions() {
    return "# Decisions\n\n| Time | Decision | Reason |\n|---|---|---|\n";
  }

  defaultTask() {
    return "# Current Task\n\n- status: idle\n";
  }

  defaultState() {
    return {
      version: 1,
      revision: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastCompactedAt: null,
      lastPackTokens: 0,
    };
  }
}

export function fileMap() {
  return { ...FILES };
}
