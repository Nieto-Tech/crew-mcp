// stdout carries the MCP protocol. Anything human-readable goes to stderr.
export function log(...args: unknown[]): void {
  console.error("[crew]", ...args);
}
