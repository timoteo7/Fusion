import { describe, expect, it } from "vitest";
import { toAcpMcpServers } from "../mcp-forwarding.js";

describe("toAcpMcpServers", () => {
  it("converts resolved stdio, streamable HTTP, and SSE definitions", () => {
    expect(toAcpMcpServers([
      { name: "local", transport: "stdio", command: "node", args: ["server.js"], env: { TOKEN: "secret" } },
      { name: "remote", transport: "streamable-http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer secret" } },
      { name: "events", transport: "sse", url: "https://mcp.example/sse" },
    ])).toEqual([
      { name: "local", command: "node", args: ["server.js"], env: [{ name: "TOKEN", value: "secret" }] },
      { type: "http", name: "remote", url: "https://mcp.example/mcp", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { type: "sse", name: "events", url: "https://mcp.example/sse", headers: [] },
    ]);
  });

  it("preserves the legacy ACP stdio shape used by the Fusion tool bridge", () => {
    expect(toAcpMcpServers([{ name: "fusion-custom-tools", command: "node", args: ["bridge.cjs"], env: [{ name: "TOKEN", value: "secret" }] }])).toEqual([
      { name: "fusion-custom-tools", command: "node", args: ["bridge.cjs"], env: [{ name: "TOKEN", value: "secret" }] },
    ]);
  });

  it("skips disabled, unnamed, incomplete, and unsupported entries", () => {
    expect(toAcpMcpServers([
      null,
      { name: "off", enabled: false, transport: "stdio", command: "node" },
      { name: "", transport: "stdio", command: "node" },
      { name: "missing-command", transport: "stdio" },
      { name: "missing-url", transport: "streamable-http" },
      { name: "unsupported", transport: "other", url: "https://mcp.example" },
    ])).toEqual([]);
  });
  it("omits remote transports not advertised by the agent", () => {
    expect(toAcpMcpServers([
      { name: "http", transport: "http", url: "https://mcp.example/http" },
      { name: "sse", transport: "sse", url: "https://mcp.example/sse" },
    ], { http: true })).toEqual([
      { type: "http", name: "http", url: "https://mcp.example/http", headers: [] },
    ]);
  });

  /*
  FNXC:AcpMcpNameValueShapes 2026-09-25-16:20:
  Every name/value field may arrive as an ACP { name, value } array, not only as a Fusion
  resolved record. Assert the concrete entries, never just the length, so an empty array —
  the credential-loss symptom — can never satisfy these tests. These cases fail against the
  pre-fix mapEntries(record.headers) / mapEntries(record.env) conversion.
  */
  it("keeps ACP name/value header arrays on both remote transports", () => {
    expect(toAcpMcpServers([
      { name: "remote-http", transport: "streamable-http", url: "https://mcp.example/http", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { name: "remote-sse", transport: "sse", url: "https://mcp.example/sse", headers: [{ name: "Authorization", value: "Bearer secret" }] },
    ])).toEqual([
      { type: "http", name: "remote-http", url: "https://mcp.example/http", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { type: "sse", name: "remote-sse", url: "https://mcp.example/sse", headers: [{ name: "Authorization", value: "Bearer secret" }] },
    ]);
  });

  it("keeps ACP name/value env arrays on the resolved-stdio branch", () => {
    expect(toAcpMcpServers([
      { name: "explicit", transport: "stdio", command: "node", args: [], env: [{ name: "TOKEN", value: "secret" }] },
    ])).toEqual([
      { name: "explicit", command: "node", args: [], env: [{ name: "TOKEN", value: "secret" }] },
    ]);
  });

  it("still maps record-shaped headers and env identically", () => {
    expect(toAcpMcpServers([
      { name: "record-http", transport: "http", url: "https://mcp.example/http", headers: { Authorization: "Bearer secret" } },
      { name: "record-stdio", transport: "stdio", command: "node", args: [], env: { TOKEN: "secret" } },
    ])).toEqual([
      { type: "http", name: "record-http", url: "https://mcp.example/http", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { name: "record-stdio", command: "node", args: [], env: [{ name: "TOKEN", value: "secret" }] },
    ]);
  });

  it("keeps name/value arrays whether or not remote capabilities are advertised", () => {
    const servers = [
      { name: "remote-http", transport: "http", url: "https://mcp.example/http", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { name: "remote-sse", transport: "sse", url: "https://mcp.example/sse", headers: [{ name: "Authorization", value: "Bearer secret" }] },
    ];
    const expected = [
      { type: "http", name: "remote-http", url: "https://mcp.example/http", headers: [{ name: "Authorization", value: "Bearer secret" }] },
      { type: "sse", name: "remote-sse", url: "https://mcp.example/sse", headers: [{ name: "Authorization", value: "Bearer secret" }] },
    ];
    expect(toAcpMcpServers(servers)).toEqual(expected);
    expect(toAcpMcpServers(servers, { http: true, sse: true })).toEqual(expected);
  });

});
