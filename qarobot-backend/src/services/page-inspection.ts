export type PageInspectionContext = {
  mode: "static_html" | "external_browser" | "unavailable";
  requestedUrl: string;
  finalUrl?: string;
  title?: string;
  headings: string[];
  buttons: Array<{ text: string; selectorHint: string }>;
  links: Array<{ text: string; href: string; selectorHint: string }>;
  inputs: Array<{ label: string; placeholder: string; type: string; selectorHint: string }>;
  visibleText: string[];
  warnings: string[];
};

export async function inspectAppPage(appUrl: string, preferredWorkerUrl?: string): Promise<PageInspectionContext> {
  const externalUrl = preferredWorkerUrl || process.env.PAGE_INSPECTION_WORKER_URL;
  if (externalUrl) {
    const external = await inspectWithExternalWorker(appUrl, externalUrl);
    if (external) return external;
  }

  return inspectWithFetch(appUrl);
}

async function inspectWithExternalWorker(appUrl: string, workerUrl: string): Promise<PageInspectionContext | null> {
  try {
    const response = await fetch(`${workerUrl.replace(/\/$/, "")}/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appUrl }),
    });
    if (!response.ok) throw new Error(`Inspection worker returned ${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as Partial<PageInspectionContext>;
    return {
      mode: "external_browser",
      requestedUrl: appUrl,
      finalUrl: payload.finalUrl,
      title: payload.title,
      headings: payload.headings || [],
      buttons: payload.buttons || [],
      links: payload.links || [],
      inputs: payload.inputs || [],
      visibleText: payload.visibleText || [],
      warnings: payload.warnings || [],
    };
  } catch (error) {
    return {
      mode: "unavailable",
      requestedUrl: appUrl,
      headings: [],
      buttons: [],
      links: [],
      inputs: [],
      visibleText: [],
      warnings: [`External browser inspection failed: ${error instanceof Error ? error.message : "unknown error"}`],
    };
  }
}

async function inspectWithFetch(appUrl: string): Promise<PageInspectionContext> {
  try {
    const response = await fetch(appUrl);
    const html = await response.text();
    return {
      mode: "static_html",
      requestedUrl: appUrl,
      finalUrl: response.url,
      title: matchFirst(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
      headings: matchAllText(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi).slice(0, 30),
      buttons: matchAllText(html, /<button[^>]*>([\s\S]*?)<\/button>/gi).slice(0, 50).map((text) => ({ text, selectorHint: "button" })),
      links: matchLinks(html).slice(0, 50),
      inputs: matchInputs(html).slice(0, 50),
      visibleText: stripHtml(html).slice(0, 3000).split(/\n+/).map(cleanText).filter(Boolean).slice(0, 20),
      warnings: ["Static HTML inspection only; dynamic browser-rendered selectors require PAGE_INSPECTION_WORKER_URL."],
    };
  } catch (error) {
    return {
      mode: "unavailable",
      requestedUrl: appUrl,
      headings: [],
      buttons: [],
      links: [],
      inputs: [],
      visibleText: [],
      warnings: [`Static HTML inspection failed: ${error instanceof Error ? error.message : "unknown error"}`],
    };
  }
}

function matchLinks(value: string) {
  return Array.from(value.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)).map((match) => {
    const attrs = match[1] || "";
    return {
      text: cleanText(stripHtml(match[2] || "")),
      href: attr(attrs, "href"),
      selectorHint: attr(attrs, "id") ? `#${attr(attrs, "id")}` : "a",
    };
  });
}

function matchInputs(value: string) {
  return Array.from(value.matchAll(/<(input|textarea|select)\b([^>]*)>/gi)).map((match) => {
    const attrs = match[2] || "";
    const id = attr(attrs, "id");
    const name = attr(attrs, "name");
    return {
      label: attr(attrs, "aria-label") || name,
      placeholder: attr(attrs, "placeholder"),
      type: attr(attrs, "type") || match[1].toLowerCase(),
      selectorHint: id ? `#${id}` : name ? `${match[1].toLowerCase()}[name="${name}"]` : match[1].toLowerCase(),
    };
  });
}

function attr(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return cleanText(match?.[1] || "");
}

function matchFirst(value: string, pattern: RegExp) {
  return cleanText(value.match(pattern)?.[1] || "");
}

function matchAllText(value: string, pattern: RegExp) {
  return Array.from(value.matchAll(pattern)).map((match) => cleanText(stripHtml(match[1] || ""))).filter(Boolean);
}

function stripHtml(value: string) {
  return value.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "\n");
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
