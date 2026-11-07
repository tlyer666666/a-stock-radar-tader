import { Fragment, useMemo, type ReactNode } from "react";
import { parseAgentMarkdown, type InlineNode, type ListItem } from "./agentMarkdown";

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return <>{nodes.map((node, index) => {
    if (node.type === "strong") return <strong key={index}>{node.text}</strong>;
    if (node.type === "code") return <code key={index}>{node.text}</code>;
    if (node.type === "up") return <span key={index} className="agent-num up">{node.text}</span>;
    if (node.type === "down") return <span key={index} className="agent-num down">{node.text}</span>;
    return <Fragment key={index}>{node.text}</Fragment>;
  })}</>;
}

function List({ ordered, start = 1, items }: { ordered: boolean; start?: number; items: ListItem[] }) {
  const children = items.map((item, index) => <li key={index}><Inline nodes={item.inline} />
    {item.children && <List ordered={item.children.ordered} items={item.children.items} />}</li>);
  return ordered ? <ol start={start}>{children}</ol> : <ul>{children}</ul>;
}

/** AI 回答正文：Markdown 子集 → React 元素（纯文本渲染，不解析 HTML 和链接）。 */
export function AgentMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseAgentMarkdown(text), [text]);
  return <div className="agent-markdown">{blocks.map((block, index): ReactNode => {
    switch (block.type) {
      case "heading": {
        const Tag = `h${block.level}` as "h3" | "h4" | "h5";
        return <Tag key={index}><Inline nodes={block.inline} /></Tag>;
      }
      case "paragraph": {
        // 开头一整行加粗的话是结论：单独突出显示。
        const lead = index === 0 && block.lines.length === 1 && block.lines[0]?.length === 1 && block.lines[0][0]?.type === "strong";
        return <p key={index} className={lead ? "agent-lead" : undefined}>{block.lines.map((line, row) => <Fragment key={row}>{row > 0 && <br />}<Inline nodes={line} /></Fragment>)}</p>;
      }
      case "list": return <List key={index} ordered={block.ordered} start={block.start} items={block.items} />;
      case "quote": return <blockquote key={index}>{block.lines.map((line, row) => <p key={row}><Inline nodes={line} /></p>)}</blockquote>;
      case "rule": return <hr key={index} />;
      case "table": return <div key={index} className="agent-table-wrap"><table>
        <thead><tr>{block.head.map((cell, col) => <th key={col} style={{ textAlign: block.align[col] || "left" }}><Inline nodes={cell} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, line) => <tr key={line}>{block.head.map((_, col) => <td key={col} style={{ textAlign: block.align[col] || "left" }}><Inline nodes={row[col] || []} /></td>)}</tr>)}</tbody>
      </table></div>;
      default: return null;
    }
  })}</div>;
}
