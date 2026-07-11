// 兼容垫片（§6-6）：MCP server 主体已迁 src/mcp/mcp-server.ts（产品部件不住工具目录）。
// 既有 MCP 接入配置指向 dist/scripts/mcp-server.js 的继续可用——re-export 触发主体模块加载，
// 自启判定（argv[1] endsWith 'mcp-server.js'）在主体内，经此入口同样满足。
export * from '../src/mcp/mcp-server.js';
