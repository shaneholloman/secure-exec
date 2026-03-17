"use client";

import { motion } from "framer-motion";

const metrics = [
  {
    label: "Cold start",
    secureExec: { value: "~10 ms", bar: 3.3 },
    sandbox: { value: "~300 ms", bar: 100, label: "Sandbox provider" },
  },
  {
    label: "Memory per instance",
    secureExec: { value: "~10 MB", bar: 7.8 },
    sandbox: { value: "~128 MB", bar: 100, label: "Sandbox provider" },
  },
  {
    label: "Cost per GB of memory",
    secureExec: { value: "~$0.10/hr", bar: 3.1 },
    sandbox: { value: "~$3.20/hr", bar: 100, label: "Sandbox provider" },
  },
  {
    label: "Extra infrastructure",
    secureExec: { value: "None", bar: 0 },
    sandbox: { value: "Cloud API + account", bar: 100, label: "Sandbox provider" },
  },
];

function BarRow({
  label,
  secureExec,
  sandbox,
}: {
  label: string;
  secureExec: { value: string; bar: number };
  sandbox: { value: string; bar: number; label: string };
}) {
  return (
    <div className="space-y-4">
      <h4 className="text-sm font-medium text-white">{label}</h4>
      <div className="space-y-3">
        {/* secure-exec bar */}
        <div className="flex items-center gap-4">
          <span className="w-40 shrink-0"><img src="/secure-exec-logo-long.svg" alt="Secure Exec" className="h-4 w-auto" /></span>
          <div className="flex-1 relative h-8 bg-white/5 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              whileInView={{ width: secureExec.bar > 0 ? `${secureExec.bar}%` : "2px" }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="absolute inset-y-0 left-0 chrome-bar"
            />
            <span
              className="absolute inset-y-0 flex items-center text-xs font-mono font-medium z-10"
              style={secureExec.bar < 15
                ? { left: `calc(${secureExec.bar}% + 8px)`, color: "rgb(161,161,170)" }
                : { left: "12px", color: "black" }
              }
            >
              {secureExec.value}
            </span>
          </div>
        </div>
        {/* Sandbox provider bar */}
        <div className="flex items-center gap-4">
          <span className="text-xs text-zinc-500 w-40 shrink-0 font-mono">{sandbox.label}</span>
          <div className="flex-1 relative h-8 bg-white/5 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              whileInView={{ width: `${sandbox.bar}%` }}
              viewport={{ once: true }}
              transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
              className="absolute inset-y-0 left-0 bg-zinc-700/80"
            />
            <span className="absolute inset-y-0 left-3 flex items-center text-xs font-mono text-zinc-300 z-10">
              {sandbox.value}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Benchmarks() {
  return (
    <section id="benchmarks" className="border-t border-white/10 py-48">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mb-12">
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="mb-2 text-2xl font-normal tracking-tight text-white md:text-4xl"
            style={{ fontFamily: "'Inter', sans-serif" }}
          >
            Benchmarks
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="max-w-xl text-base leading-relaxed text-zinc-500"
          >
            V8 isolates vs. container-based sandboxes. Same security guarantees, but fundamentally different overhead.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="space-y-8 rounded-xl bg-white/[0.02] p-8 chrome-gradient-border"
          style={{ "--chrome-angle": "75deg" } as React.CSSProperties}
        >
          <p className="text-xs text-zinc-500 italic">Lower is better</p>
          {metrics.map((metric) => (
            <BarRow key={metric.label} {...metric} />
          ))}
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-4 text-xs text-zinc-600"
        >
          Sandbox provider numbers based on published documentation and pricing. Cost comparison: secure-exec memory cost based on EC2 on-demand pricing; sandbox provider cost based on published per-sandbox pricing. Secure Exec measured on Apple M-series, Node.js 22.
        </motion.p>
      </div>
    </section>
  );
}
