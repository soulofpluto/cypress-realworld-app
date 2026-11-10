/* eslint-disable no-console */
/**
 * TCC – Mitigação de Flaky Tests em Automação E2E
 *
 * Agrega os JSONs gerados por run-experiment.js e calcula, por grupo (cenário × hardware):
 *   - Flaky Test Rate: % de testes que passaram em alguma execução e falharam em outra
 *   - Determinismo:    % de testes com o mesmo resultado em todas as execuções
 *   - Duração da build: média, desvio padrão, mínimo e máximo (wall clock do Cypress)
 * Também compara cada cenário com o baseline (teste exato de Fisher, bicaudal).
 *
 * Uso:
 *   node scripts/experiment/analyze-results.js [diretório]   (padrão: experiment-results)
 *
 * Saídas: <dir>/summary.csv, <dir>/per-test.csv, <dir>/report.md
 */
const fs = require("fs");
const path = require("path");

const dir = path.resolve(process.argv[2] || "experiment-results");

function listJson(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return listJson(p);
    return e.name.endsWith(".json") ? [p] : [];
  });
}

const records = listJson(dir)
  .map((f) => JSON.parse(fs.readFileSync(f, "utf-8")))
  .filter((r) => r && r.scenario && Array.isArray(r.tests));

if (records.length === 0) {
  console.error(`Nenhum resultado encontrado em ${dir}`);
  process.exit(1);
}

// ---------- estatística ----------
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

const logFact = (() => {
  const cache = [0];
  return (n) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i);
    return cache[n];
  };
})();

// Teste exato de Fisher bicaudal para a tabela [[a, b], [c, d]]
function fisherExact(a, b, c, d) {
  const r1 = a + b;
  const r2 = c + d;
  const c1 = a + c;
  const n = r1 + r2;
  const p = (x) =>
    Math.exp(
      logFact(r1) + logFact(r2) + logFact(c1) + logFact(n - c1) -
        (logFact(n) + logFact(x) + logFact(r1 - x) + logFact(c1 - x) + logFact(r2 - c1 + x))
    );
  const pObs = p(a);
  let total = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) {
    const px = p(x);
    if (px <= pObs * (1 + 1e-7)) total += px;
  }
  return Math.min(1, total);
}

// ---------- agregação ----------
const groups = new Map();
for (const r of records) {
  const key = `${r.scenario}__${r.label}`;
  if (!groups.has(key)) groups.set(key, { scenario: r.scenario, label: r.label, runs: [] });
  groups.get(key).runs.push(r);
}

const summaries = [];
const perTestRows = [];

for (const g of groups.values()) {
  const byTest = new Map();
  for (const run of g.runs) {
    for (const t of run.tests) {
      if (t.state !== "passed" && t.state !== "failed") continue; // ignora pending/skipped
      const k = `${t.spec} :: ${t.title}`;
      if (!byTest.has(k)) byTest.set(k, { spec: t.spec, title: t.title, passed: 0, failed: 0 });
      byTest.get(k)[t.state]++;
    }
  }

  let flaky = 0;
  let alwaysPass = 0;
  let alwaysFail = 0;
  for (const t of byTest.values()) {
    const cls = t.passed > 0 && t.failed > 0 ? "flaky" : t.failed === 0 ? "always_pass" : "always_fail";
    if (cls === "flaky") flaky++;
    else if (cls === "always_pass") alwaysPass++;
    else alwaysFail++;
    perTestRows.push({ scenario: g.scenario, label: g.label, ...t, classification: cls });
  }

  const total = byTest.size;
  const durations = g.runs.map((r) => r.wallClockMs / 1000);
  const greenBuilds = g.runs.filter((r) => r.totals.failed === 0).length;

  summaries.push({
    scenario: g.scenario,
    label: g.label,
    runs: g.runs.length,
    tests: total,
    flaky,
    alwaysPass,
    alwaysFail,
    flakyRate: total ? flaky / total : 0,
    determinism: total ? (alwaysPass + alwaysFail) / total : 0,
    greenBuildRate: greenBuilds / g.runs.length,
    durMean: mean(durations),
    durSd: sd(durations),
    durMin: Math.min(...durations),
    durMax: Math.max(...durations),
  });
}

const order = { baseline: 0, fault: 1, refactored: 2 };
summaries.sort((a, b) => a.label.localeCompare(b.label) || order[a.scenario] - order[b.scenario]);

// ---------- saída ----------
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const s1 = (x) => x.toFixed(1);
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
const toCsv = (rows) =>
  rows.length
    ? [Object.keys(rows[0]).join(","), ...rows.map((r) => Object.values(r).map(csvCell).join(","))].join("\n")
    : "";

fs.writeFileSync(path.join(dir, "summary.csv"), toCsv(summaries));
fs.writeFileSync(path.join(dir, "per-test.csv"), toCsv(perTestRows));

const md = [];
md.push("# Resultados do experimento\n");
md.push(
  "| Cenário | Hardware | Execuções | Testes | Flaky | Flaky Test Rate | Determinismo | Sempre falha | Builds verdes | Duração média (s) | DP (s) |"
);
md.push("|---|---|---|---|---|---|---|---|---|---|---|");
for (const s of summaries) {
  md.push(
    `| ${s.scenario} | ${s.label} | ${s.runs} | ${s.tests} | ${s.flaky} | ${pct(s.flakyRate)} | ${pct(
      s.determinism
    )} | ${s.alwaysFail} | ${pct(s.greenBuildRate)} | ${s1(s.durMean)} | ${s1(s.durSd)} |`
  );
}

md.push("\n## Comparação com o baseline (teste exato de Fisher, testes flaky vs. não flaky)\n");
md.push("| Hardware | Cenário | Flaky (cenário) | Flaky (baseline) | p-valor |");
md.push("|---|---|---|---|---|");
for (const s of summaries) {
  if (s.scenario === "baseline") continue;
  const b = summaries.find((x) => x.scenario === "baseline" && x.label === s.label);
  if (!b) continue;
  const p = fisherExact(s.flaky, s.tests - s.flaky, b.flaky, b.tests - b.flaky);
  md.push(`| ${s.label} | ${s.scenario} | ${s.flaky}/${s.tests} | ${b.flaky}/${b.tests} | ${p.toFixed(4)} |`);
}

const flakyTests = perTestRows.filter((r) => r.classification === "flaky");
if (flakyTests.length) {
  md.push("\n## Testes instáveis identificados\n");
  md.push("| Cenário | Hardware | Spec | Teste | Passou | Falhou |");
  md.push("|---|---|---|---|---|---|");
  for (const t of flakyTests) {
    md.push(`| ${t.scenario} | ${t.label} | ${t.spec} | ${t.title.replace(/\|/g, "\\|")} | ${t.passed} | ${t.failed} |`);
  }
}

md.push(
  "\n> **Flaky**: passou e falhou entre execuções do mesmo cenário. **Sempre falha**: falha determinística " +
    "(teste quebrado, não instável). **Determinismo** = (sempre passa + sempre falha) / testes."
);

const report = md.join("\n");
fs.writeFileSync(path.join(dir, "report.md"), report);
console.log(report);
