import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMcpConfig } from "./config-loader.js";

describe("loadMcpConfig", () => {
  let dir: string;

  async function writeConfig(content: string): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "mcp-config-test-"));
    const path = join(dir, "mcp.json");
    await writeFile(path, content, "utf-8");
    return path;
  }

  // Clean up temp dir after each test
  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("returns empty config when file does not exist", async () => {
    const config = await loadMcpConfig("/tmp/does-not-exist-" + Date.now() + ".json");
    expect(config).toEqual({ mcpServers: {} });
  });

  it("loads a valid stdio server config", async () => {
    const path = await writeConfig(
      JSON.stringify({
        mcpServers: {
          "test-server": {
            type: "stdio",
            command: "node",
            args: ["server.js"],
            env: { API_KEY: "secret" },
          },
        },
      }),
    );

    const config = await loadMcpConfig(path);
    expect(config.mcpServers["test-server"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { API_KEY: "secret" },
    });
  });

  it("loads a valid remote server config", async () => {
    const path = await writeConfig(
      JSON.stringify({
        mcpServers: {
          "remote-server": {
            type: "remote",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer tok" },
          },
        },
      }),
    );

    const config = await loadMcpConfig(path);
    expect(config.mcpServers["remote-server"]).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("loads mixed server types", async () => {
    const path = await writeConfig(
      JSON.stringify({
        mcpServers: {
          local: { type: "stdio", command: "python", args: ["-m", "mcp_server"] },
          cloud: { type: "remote", url: "https://api.example.com/mcp" },
        },
      }),
    );

    const config = await loadMcpConfig(path);
    expect(Object.keys(config.mcpServers)).toEqual(["local", "cloud"]);
    expect(config.mcpServers["local"].type).toBe("stdio");
    expect(config.mcpServers["cloud"].type).toBe("remote");
  });

  it("throws on invalid JSON", async () => {
    const path = await writeConfig("not json {{{");
    await expect(loadMcpConfig(path)).rejects.toThrow("Invalid JSON");
  });

  it("throws on schema violation (missing required fields)", async () => {
    const path = await writeConfig(
      JSON.stringify({
        mcpServers: {
          bad: { type: "stdio" }, // missing "command"
        },
      }),
    );
    await expect(loadMcpConfig(path)).rejects.toThrow("Invalid MCP config");
  });

  it("throws on unknown server type", async () => {
    const path = await writeConfig(
      JSON.stringify({
        mcpServers: {
          bad: { type: "websocket", url: "ws://localhost" },
        },
      }),
    );
    await expect(loadMcpConfig(path)).rejects.toThrow("Invalid MCP config");
  });
});
