import Link from "next/link";
import { Bot, FileText, FlaskConical, ListChecks, Play, Settings, Wand2, Wrench } from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: Bot },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/models", label: "Models", icon: Settings },
  { href: "/test-plans", label: "Plans", icon: ListChecks },
  { href: "/test-cases", label: "Cases", icon: FlaskConical },
  { href: "/scripts", label: "Scripts", icon: Wand2 },
  { href: "/runner", label: "Runner", icon: Play },
  { href: "/healer", label: "Healer", icon: Wrench },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-white px-4 py-5 md:block">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-action text-white">
            <Bot size={19} />
          </div>
          <div>
            <div className="text-sm font-semibold">QA Robot</div>
            <div className="text-xs text-slate-500">Core build</div>
          </div>
        </div>
        <nav className="space-y-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              <item.icon size={17} />
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="md:pl-64">
        <div className="mx-auto max-w-7xl px-5 py-6">{children}</div>
      </main>
    </div>
  );
}
