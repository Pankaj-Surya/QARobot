"use client";

import { AppShell } from "@/components/app-shell";
import { useEffect, useState } from "react";

type LocalScript = {
  id: string;
  name: string;
  appUrl: string | null;
  files: Record<string, string>;
  createdAt?: string;
};

const LOCAL_SCRIPTS_KEY = "qarobot.generatedScripts";

export default function HealerPage() {
  const [latestScript, setLatestScript] = useState<LocalScript | null>(null);

  useEffect(() => {
    try {
      const scripts = JSON.parse(localStorage.getItem(LOCAL_SCRIPTS_KEY) || "[]") as LocalScript[];
      setLatestScript(Array.isArray(scripts) ? scripts[0] || null : null);
    } catch {
      setLatestScript(null);
    }

    const cleanup = () => localStorage.removeItem(LOCAL_SCRIPTS_KEY);
    window.addEventListener("beforeunload", cleanup);
    return () => window.removeEventListener("beforeunload", cleanup);
  }, []);

  const spec = latestScript ? getRunnableSpec(latestScript.files) : "";

  return (
    <AppShell>
      <h1 className="mb-4 text-xl font-semibold">Test Healer</h1>
      <div className="rounded-md border border-line bg-white p-5 text-sm text-slate-600">
        Heal suggestions will appear here after runner failures produce selector data.
      </div>
      <section className="mt-5 rounded-md border border-line bg-white">
        <div className="border-b border-line px-5 py-4 text-sm font-semibold">Latest Temporary Script</div>
        {latestScript ? (
          <div>
            <div className="border-b border-line px-5 py-3 text-sm">
              <div className="font-medium">{latestScript.name}</div>
              <div className="mt-1 break-all text-slate-500">{latestScript.appUrl || "-"}</div>
            </div>
            <pre className="max-h-[520px] overflow-auto bg-slate-950 p-4 text-sm text-slate-100">
              <code>{spec || "No runnable spec file found."}</code>
            </pre>
          </div>
        ) : (
          <div className="px-5 py-8 text-sm text-slate-500">No temporary generated script is available in this browser session.</div>
        )}
      </section>
    </AppShell>
  );
}

function getRunnableSpec(files: Record<string, string>) {
  return files["tests/generated.spec.ts"] || files["tests/pasted.spec.ts"] || Object.entries(files).find(([file]) => file.endsWith(".spec.ts"))?.[1] || "";
}
