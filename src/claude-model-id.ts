const prefix = "claude-fable-5-dd-"

/**
 * 對應 CPA internal/client/claude/models/models.go 的 ResolveClaudeModelIDPrefix。
 * 依最後一個左括號拆出 thinking 後綴，再以 Unicode code point 反轉模型 id。
 */
export function resolveClaudeModelIDPrefix(id: string): string {
  const open = id.lastIndexOf("(")
  const hasSuffix = open !== -1 && id.endsWith(")")
  const base = hasSuffix ? id.slice(0, open) : id
  if (!base.startsWith(prefix)) return id
  const encoded = base.slice(prefix.length)
  if (!encoded) return id
  const resolved = [...encoded].reverse().join("")
  return hasSuffix ? `${resolved}(${id.slice(open + 1, -1)})` : resolved
}
