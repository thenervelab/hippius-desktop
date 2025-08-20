import React from "react";

type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: 1 | 2 | 3; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

function parseBasicMd(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let items: string[] = [];

  const flushPara = () => {
    if (para.length) out.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (listType && items.length)
      out.push({ type: listType, items: [...items] });
    listType = null;
    items = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }

    // #, ##, ### => h1/h2/h3
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const level = h[1].length as 1 | 2 | 3;
      out.push({ type: "h", level, text: h[2] });
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== "ul") {
        flushList();
        listType = "ul";
      }
      items.push(ul[1]);
      continue;
    }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        flushList();
        listType = "ol";
      }
      items.push(ol[1]);
      continue;
    }

    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  return out;
}

function renderInline(text: string): (string | React.JSX.Element)[] {
  const nodes: (string | React.JSX.Element)[] = [];
  const re =
    /(\*\*\*[^*]+?\*\*\*|___[^_]+?___|\*\*[^*]+?\*\*|__[^_]+?__|\*[^*\n]+?\*|_[^_\n]+?_)/g;

  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) nodes.push(text.slice(last, i));
    const token = m[0];

    if (token.startsWith("***") || token.startsWith("___")) {
      const inner = token.slice(3, -3);
      nodes.push(
        <strong key={i}>
          <em>{inner}</em>
        </strong>
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const inner = token.slice(2, -2);
      nodes.push(<strong key={i}>{inner}</strong>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      const inner = token.slice(1, -1);
      nodes.push(<em key={i}>{inner}</em>);
    } else {
      nodes.push(token);
    }
    last = i + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function BasicMarkdown({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseBasicMd(text), [text]);
  return (
    <div className="text-sm text-grey-60">
      {blocks.map((b, i) => {
        if (b.type === "p")
          return (
            <p key={i} className="mt-2 leading-6">
              {renderInline(b.text)}
            </p>
          );
        if (b.type === "h") {
          if (b.level === 1)
            return (
              <h1 key={i} className="text-lg font-semibold mt-4 mb-2">
                {renderInline(b.text)}
              </h1>
            );
          if (b.level === 2)
            return (
              <h2 key={i} className="text-base font-semibold mt-4 mb-2">
                {renderInline(b.text)}
              </h2>
            );
          return (
            <h3 key={i} className="text-sm font-semibold mt-3 mb-2">
              {renderInline(b.text)}
            </h3>
          );
        }
        if (b.type === "ul")
          return (
            <ul key={i} className="list-disc pl-5 space-y-1 mt-2">
              {b.items.map((t, j) => (
                <li key={j}>{renderInline(t)}</li>
              ))}
            </ul>
          );
        return (
          <ol key={i} className="list-decimal pl-5 space-y-1 mt-2">
            {b.items.map((t, j) => (
              <li key={j}>{renderInline(t)}</li>
            ))}
          </ol>
        );
      })}
    </div>
  );
}

export default BasicMarkdown;
