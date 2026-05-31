type MarkdownPreviewProps = {
  content: string;
  emptyText?: string;
};

export function MarkdownPreview({ content, emptyText = "Nothing to preview yet." }: MarkdownPreviewProps) {
  const blocks = parseMarkdown(content);

  if (blocks.length === 0) {
    return <div className="text-sm text-slate-500">{emptyText}</div>;
  }

  return (
    <div className="min-w-0 space-y-4 text-sm leading-6 text-slate-800">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Tag = block.level === 1 ? "h2" : block.level === 2 ? "h3" : "h4";
          return (
            <Tag key={index} className={block.level === 1 ? "text-xl font-semibold" : "text-base font-semibold"}>
              {block.text}
            </Tag>
          );
        }

        if (block.type === "list") {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </ul>
          );
        }

        if (block.type === "table") {
          const [header, separator, ...rows] = block.rows;
          const headerCells = splitTableRow(header);
          const bodyRows = separator ? rows : block.rows.slice(1);

          return (
            <div key={index} className="w-max min-w-full rounded-md border border-line">
              <table className="min-w-[1400px] divide-y divide-line">
                <thead className="bg-slate-50">
                  <tr>
                    {headerCells.map((cell, cellIndex) => (
                      <th
                        key={cellIndex}
                        className="min-w-[130px] px-3 py-2 text-left text-xs font-semibold uppercase text-slate-500"
                      >
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line bg-white">
                  {bodyRows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {splitTableRow(row).map((cell, cellIndex) => (
                        <td key={cellIndex} className="min-w-[130px] max-w-[260px] whitespace-pre-wrap px-3 py-3 align-top text-sm">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p key={index} className="whitespace-pre-wrap">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; rows: string[] };

function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let table: string[] = [];

  function flushParagraph() {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  }

  function flushList() {
    if (list.length > 0) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  }

  function flushTable() {
    if (table.length > 0) {
      blocks.push({ type: "table", rows: table });
      table = [];
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    if (line.startsWith("|") && line.endsWith("|")) {
      flushParagraph();
      flushList();
      table.push(line);
      continue;
    }

    if (/^#{1,4}\s/.test(line)) {
      flushParagraph();
      flushList();
      flushTable();
      const marker = line.match(/^#+/)?.[0] || "#";
      blocks.push({ type: "heading", level: marker.length, text: line.slice(marker.length).trim() });
      continue;
    }

    if (line.startsWith("- ")) {
      flushParagraph();
      flushTable();
      list.push(line.slice(2).trim());
      continue;
    }

    flushList();
    flushTable();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushTable();

  return blocks.filter((block) => {
    if (block.type === "table") {
      return block.rows.some((row) => !/^\|?\s*-+/.test(row.replace(/\|/g, "").trim()));
    }

    return true;
  });
}

function splitTableRow(row: string) {
  return row
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => !/^:?-{3,}:?$/.test(cell));
}
