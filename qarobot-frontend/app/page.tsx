import { AppShell } from "@/components/app-shell";
import { ModuleCard } from "@/components/module-card";
import { FileText, FlaskConical, ListChecks, Play, Settings, Wand2, Wrench } from "lucide-react";

const modules = [
  {
    href: "/documents",
    title: "Documents",
    description: "Upload requirements and build the RAG source library.",
    icon: FileText,
  },
  {
    href: "/models",
    title: "Model Connector",
    description: "Configure AI providers per task type.",
    icon: Settings,
  },
  {
    href: "/test-plans",
    title: "Test Plans",
    description: "Generate test plans from scope and RAG pipeline evidence.",
    icon: ListChecks,
  },
  {
    href: "/test-cases",
    title: "Test Cases",
    description: "Generate structured test cases and save selected rows.",
    icon: FlaskConical,
  },
  {
    href: "/scripts",
    title: "Test Scripts",
    description: "Generate editable Playwright code with a file tree.",
    icon: Wand2,
  },
  {
    href: "/runner",
    title: "Runner",
    description: "Run scripts and stream execution logs over SSE.",
    icon: Play,
  },
  {
    href: "/healer",
    title: "Healer",
    description: "Review selector healing suggestions from failed runs.",
    icon: Wrench,
  },
];

export default function HomePage() {
  return (
    <AppShell>
      <section className="mb-6">
        <h1 className="text-2xl font-semibold tracking-normal">QA Robot</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Separate Next.js frontend and Fastify backend scaffold for the core QA automation workflow.
        </p>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((module) => (
          <ModuleCard key={module.href} {...module} />
        ))}
      </section>
    </AppShell>
  );
}
