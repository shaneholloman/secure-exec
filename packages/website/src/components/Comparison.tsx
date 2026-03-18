"use client";

import { motion } from "framer-motion";

const secureExecItems = [
  "Native V8 performance",
  "Granular deny-by-default permissions",
  "Just npm install — no vendor account",
  "Run on any cloud or hardware",
  "No egress fees",
  "No API keys to manage",
];

const sandboxItems = [
  "Native container performance",
  "Coarse-grained permissions",
  "Vendor account required",
  "Hardware lock-in",
  "Per-GB egress fees",
  "API keys to manage",
];

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <span className="text-sky-400 shrink-0">✓</span>
      <span className="text-zinc-300">{children}</span>
    </div>
  );
}

function CrossItem({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <span className="text-zinc-600 shrink-0">✗</span>
      <span className="text-zinc-500">{children}</span>
    </div>
  );
}

export function Comparison() {
  return (
    <section className="py-24">
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
            Secure Exec vs. Sandboxes
          </motion.h2>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="max-w-xl text-base leading-relaxed text-zinc-500"
          >
            Not every workload needs a full OS. Secure Exec gives you V8-level isolation for code execution — no container required.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="grid grid-cols-1 sm:grid-cols-2 gap-6"
        >
          {/* Secure Exec column */}
          <div
            className="rounded-xl bg-sky-500/[0.03] p-6 sm:p-8 space-y-5 chrome-gradient-border"
            style={{ "--chrome-angle": "170deg" } as React.CSSProperties}
          >
            <div className="mb-6">
              <img src="/secure-exec-logo-long.svg" alt="Secure Exec" className="h-5 w-auto mb-2" />
              <p className="text-sm text-zinc-400">Run untrusted code (Node.js, Python) inside your backend process</p>
            </div>
            <div className="space-y-3.5">
              {secureExecItems.map((item) => (
                <CheckItem key={item}>{item}</CheckItem>
              ))}
            </div>
          </div>

          {/* Sandbox provider column */}
          <div
            className="rounded-xl bg-white/[0.02] p-6 sm:p-8 space-y-5 chrome-gradient-border"
            style={{ "--chrome-angle": "200deg" } as React.CSSProperties}
          >
            <div className="mb-6">
              <span className="text-sm text-zinc-500 font-mono">Sandbox</span>
              <p className="text-sm text-zinc-400 mt-2">Spin up a full OS with root access, system packages, and persistent disk</p>
            </div>
            <div className="space-y-3.5">
              {sandboxItems.map((item, i) => (
                i === 0 ? <CheckItem key={item}>{item}</CheckItem> : <CrossItem key={item}>{item}</CrossItem>
              ))}
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="mt-6 text-center"
        >
          <a
            href="/docs/comparison/sandbox"
            className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm btn-chrome-outline"
          >
            Full comparison guide
            <span aria-hidden="true">→</span>
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="mt-10 rounded-xl bg-white/[0.02] p-6 sm:p-8 chrome-gradient-border"
          style={{ "--chrome-angle": "50deg" } as React.CSSProperties}
        >
          <div>
            <div className="flex items-center gap-2 mb-3">
              <p className="text-xs font-medium uppercase tracking-widest text-zinc-500">Need a full sandboxed operating system? We've got that too.</p>
            </div>
            <img src="/sandbox-agent-logo.svg" alt="Sandbox Agent SDK" className="h-6 w-auto mb-4" />
            <p className="text-sm text-zinc-400 max-w-2xl">
              Run coding agents in sandboxes. Control them over HTTP.
            </p>
            <p className="text-sm text-zinc-400 mt-1">
              Supports Claude Code, Codex, OpenCode, Amp, and Pi.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-6 pt-6 border-t border-white/10">
            <div className="flex flex-col gap-2">
              <span className="text-xs text-zinc-600">Works with</span>
              <div className="flex items-center gap-4 opacity-50">
              {[
                { src: "/logos/sandbox-agent/e2b.svg", alt: "E2B", wide: true },
                { src: "/logos/sandbox-agent/daytona.svg", alt: "Daytona", wide: true },
                { src: "/logos/sandbox-agent/vercel.svg", alt: "Vercel" },
                { src: "/logos/sandbox-agent/docker.svg", alt: "Docker" },
                { src: "/logos/sandbox-agent/cloudflare.svg", alt: "Cloudflare" },
              ].map((logo) => (
                <img key={logo.alt} src={logo.src} alt={logo.alt} title={logo.alt} className={"wide" in logo && logo.wide ? "h-5 w-auto" : "h-5 w-5"} />
              ))}
              </div>
            </div>
            <a
              href="https://sandboxagent.dev/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm btn-chrome-outline"
            >
              Learn more
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
