import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";

export function ModuleCard({
  href,
  title,
  description,
  icon: Icon,
}: {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Link href={href} className="block rounded-md border border-line bg-white p-5 hover:border-slate-400">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-blue-50 text-action">
        <Icon size={20} />
      </div>
      <div className="mb-1 text-sm font-semibold">{title}</div>
      <p className="mb-4 min-h-10 text-sm leading-5 text-slate-500">{description}</p>
      <div className="flex items-center gap-2 text-sm font-medium text-action">
        Open <ArrowRight size={15} />
      </div>
    </Link>
  );
}
