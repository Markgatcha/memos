import {
  getMcpTools,
  isMcpToolEnabled,
  MCP_CORE_TOOL_NAMES,
  resolveMcpToolSet,
} from "../src/mcp";

const PREVIOUS = process.env.MEMOS_MCP_TOOLS;

afterEach(() => {
  if (PREVIOUS === undefined) delete process.env.MEMOS_MCP_TOOLS;
  else process.env.MEMOS_MCP_TOOLS = PREVIOUS;
});

describe("MCP tool profiles", () => {
  test("the default profile is the core set, not all 40 tools", () => {
    delete process.env.MEMOS_MCP_TOOLS;
    const tools = getMcpTools();
    expect(tools).toHaveLength(MCP_CORE_TOOL_NAMES.length);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set(MCP_CORE_TOOL_NAMES),
    );
  });

  test("MEMOS_MCP_TOOLS=all restores the full surface", () => {
    process.env.MEMOS_MCP_TOOLS = "all";
    expect(getMcpTools()).toHaveLength(40);
  });

  test("MEMOS_MCP_TOOLS=none hides every tool but keeps the server valid", () => {
    process.env.MEMOS_MCP_TOOLS = "none";
    expect(getMcpTools()).toHaveLength(0);
    expect(resolveMcpToolSet("none")?.size).toBe(0);
  });

  test("a comma-separated list selects exactly those tools", () => {
    process.env.MEMOS_MCP_TOOLS = "memos_store,memos_search";
    expect(getMcpTools().map((tool) => tool.name)).toEqual([
      "memos_store",
      "memos_search",
    ]);
    expect(isMcpToolEnabled("memos_store")).toBe(true);
    expect(isMcpToolEnabled("memos_forget")).toBe(false);
  });

  test("standard and core are aliases for the default", () => {
    expect(resolveMcpToolSet("standard")?.size).toBe(
      MCP_CORE_TOOL_NAMES.length,
    );
    expect(resolveMcpToolSet("core")?.size).toBe(MCP_CORE_TOOL_NAMES.length);
    expect(resolveMcpToolSet("all")).toBeNull();
  });
});
