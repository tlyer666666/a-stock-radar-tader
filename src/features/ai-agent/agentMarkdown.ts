/**
 * AI 问股回答的 Markdown 解析（只支持回答里会用到的子集）：标题、段落、列表（一层嵌套）、表格、引用、分隔线，
 * 行内的 **加粗**、`代码` 和带正负号的百分数（按涨跌着色）。不解析链接和 HTML，输出交给 React 当纯文本渲染。
 */

export type InlineNode = { type: "text" | "strong" | "code" | "up" | "down"; text: string };
export type ListItem = { inline: InlineNode[]; children: { ordered: boolean; items: ListItem[] } | null };
export type MarkdownBlock =
  | { type: "heading"; level: 3 | 4 | 5; inline: InlineNode[] }
  | { type: "paragraph"; lines: InlineNode[][] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; head: InlineNode[][]; rows: InlineNode[][][]; align: ("left" | "right" | "center")[] }
  | { type: "quote"; lines: InlineNode[][] }
  | { type: "rule" };

// 前面紧挨着数字时不算（如「3-5%」是区间）。
const SIGNED_PERCENT = /((?<![\d.%])[+＋\-－−]\d+(?:\.\d+)?%)/;

/** 行内：**加粗**、`代码`、+3.2% / -1.5%。 */
export function parseInline(source: string): InlineNode[] {
  const out: InlineNode[] = [];
  const push = (type: InlineNode["type"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (type === "text" && last?.type === "text") last.text += text;
    else out.push({ type, text });
  };
  const pattern = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+?`)/g;
  let cursor = 0;
  const plain = (text: string) => {
    // 带正负号的百分数：正数红、负数绿（只认明确写了 + 或 - 的）。
    text.split(SIGNED_PERCENT).forEach((part, index) => {
      if (index % 2) push(/^[+＋]/.test(part) ? "up" : "down", part);
      else push("text", part);
    });
  };
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    plain(source.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("`")) push("code", token.slice(1, -1));
    else push("strong", token.slice(2, -2));
    cursor = index + token.length;
  }
  plain(source.slice(cursor));
  return out;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+•]|\d+[.)、])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());

export function parseAgentMarkdown(text: string): MarkdownBlock[] {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: InlineNode[][] = [];
  const flush = () => { if (paragraph.length) blocks.push({ type: "paragraph", lines: paragraph }); paragraph = []; };
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) { flush(); index += 1; continue; }
    if (/^```/.test(trimmed)) { index += 1; continue; } // 代码块围栏：保留里面的文字当普通段落
    const heading = trimmed.match(HEADING);
    if (heading) {
      flush();
      const hashes = heading[1]?.length ?? 3;
      blocks.push({ type: "heading", level: hashes <= 2 ? 3 : hashes === 3 ? 4 : 5, inline: parseInline((heading[2] ?? "").replace(/\s#+\s*$/, "")) });
      index += 1; continue;
    }
    if (RULE.test(trimmed)) { flush(); blocks.push({ type: "rule" }); index += 1; continue; }
    if (trimmed.startsWith("|") && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      flush();
      const head = cells(trimmed).map(parseInline);
      const align = cells(lines[index + 1] ?? "").map(cell => cell.startsWith(":") && cell.endsWith(":") ? "center" as const : cell.endsWith(":") ? "right" as const : "left" as const);
      const rows: InlineNode[][][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) { rows.push(cells(lines[index] ?? "").map(parseInline)); index += 1; }
      blocks.push({ type: "table", head, rows, align });
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      const quote: InlineNode[][] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith(">")) { quote.push(parseInline((lines[index] ?? "").trim().replace(/^>\s?/, ""))); index += 1; }
      blocks.push({ type: "quote", lines: quote });
      continue;
    }
    const item = line.match(LIST);
    if (item) {
      flush();
      const ordered = /^\d/.test(item[2] ?? "");
      const start = ordered ? Number.parseInt(item[2] ?? "1", 10) || 1 : 1;
      const baseIndent = (item[1] ?? "").length;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const current = (lines[index] ?? "").match(LIST);
        if (!current) {
          // 列表项的续行（缩进的普通文字）并进上一项。
          const continuation = lines[index] ?? "";
          if (continuation.trim() && /^\s{2,}/.test(continuation) && items.length) { items[items.length - 1]!.inline.push({ type: "text", text: " " }, ...parseInline(continuation.trim())); index += 1; continue; }
          break;
        }
        const indent = (current[1] ?? "").length;
        const currentOrdered = /^\d/.test(current[2] ?? "");
        if (indent > baseIndent + 1 && items.length) {
          const parent = items[items.length - 1]!;
          parent.children ||= { ordered: currentOrdered, items: [] };
          parent.children.items.push({ inline: parseInline(current[3] ?? ""), children: null });
          index += 1; continue;
        }
        if (indent < baseIndent || currentOrdered !== ordered) break;
        items.push({ inline: parseInline(current[3] ?? ""), children: null });
        index += 1;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }
    paragraph.push(parseInline(trimmed));
    index += 1;
  }
  flush();
  return blocks;
}

/** 复制用的纯文本：去掉 Markdown 记号。 */
export function markdownToPlainText(text: string): string {
  return String(text || "").replace(/\r\n?/g, "\n").split("\n").filter(line => !TABLE_SEPARATOR.test(line)).map(line => line
    .replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*>\s?/, "").replace(/^\s*\|(.*)\|\s*$/, (_, inner: string) => inner.split("|").map(cell => cell.trim()).join("  ")))
    .filter((line, index, all) => !(line.trim() === "" && all[index - 1]?.trim() === "")).join("\n").trim();
}
