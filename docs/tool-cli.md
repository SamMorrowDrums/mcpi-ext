# Tier 2 — The Nuclear Football (tool-cli)

`tool-cli` is a thin CLI binary that speaks JSON-RPC 2.0 to the extension over HTTP. The agent uses it like any shell command — composable with pipes, grep, jq, loops.

## Architecture

```mermaid
flowchart TD
    A["Agent (mcpi)"] -->|shell exec| B["tool-cli &lt;server&gt; &lt;tool&gt; '{args}'"]
    B -->|"HTTP JSON-RPC (random port, token auth)"| C["ToolCliServer (from @sammorrowdrums/tool-cli)"]
    C -->|"MCP protocol (stdio/HTTP)"| D["MCP Server(s)"]
```

The RPC server lives in the extension process, started on `session_start` and stopped on `session_shutdown`. The CLI binary uses `fetch` to call it.

Tool execution returns the same terminal MCP `CallToolResult` used by direct tools
and Code Mode. Text, image, audio, resource links, embedded resources, arbitrary
JSON `structuredContent`, and `isError` are retained through the provider boundary.
Protocol and transport failures remain rejected RPC calls rather than being
converted into successful-looking tool results.

## Progressive discovery

The agent pays only the tokens it needs:

```sh
tool-cli --help                              # What servers exist?
tool-cli github                              # What tools does this server have?
tool-cli github search_code                  # What's the schema for this tool?
tool-cli github search_code '{"query":"auth"}' # Call it
```

## Shell composability

```sh
# Chain tool calls
tool-cli myserver list_items '{}' | jq -r '.[0].id' | \
  xargs -I{} tool-cli myserver get_item '{"id":"{}"}'

# Process collections
for city in London Tokyo Paris; do
  echo "=== $city ==="
  tool-cli weather check_weather '{"city":"'"$city"'"}'
done

# Combine with the Unix toolbox
tool-cli myserver export_csv '{"table":"users"}' | sort -t, -k2 | head -20
```

## Security

The server uses token-based auth and dynamic port allocation (provided by [`@sammorrowdrums/tool-cli`](https://github.com/SamMorrowDrums/tool-cli)):

1. `start()` binds to a random port and generates a 32-byte session token
2. Returns `{ port, token }` — the extension sets these as env vars via `pi.setEnv()`
3. Every request must include `Authorization: Bearer <token>` — rejected with 401 otherwise

This enables concurrent sessions and prevents random processes from calling MCP tools. Authentication is not authorization, though: `ToolCliServer.callTool` forwards `server`/`tool`/`args` to the provider without checking them against the discovered set, so an authenticated caller could otherwise name a tool the CLI never advertised. `createPolicyToolProvider` routes every RPC call back through `McpPolicy` — the shared authorization boundary that also serves the proxy, Code Mode, and resource paths — which is where tool annotations are checked and non-read-only calls are gated through user confirmation.

See [tool-cli security docs](https://github.com/SamMorrowDrums/tool-cli#security) and [DECISIONS.md #010](../DECISIONS.md).
