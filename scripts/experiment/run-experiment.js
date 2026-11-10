/* eslint-disable no-console */
/**
 * TCC – Mitigação de Flaky Tests em Automação E2E
 *
 * Executa a suíte de UI N vezes em um cenário experimental e grava um JSON por execução
 * em experiment-results/. Requer a aplicação rodando (yarn start:ci ou yarn dev).
 *
 * Uso:
 *   node scripts/experiment/run-experiment.js --scenario fault --runs 5
 *
 * Opções:
 *   --scenario  baseline | fault | refactored   (padrão: baseline)
 *   --runs      número de repetições              (padrão: 1)
 *   --run-id    rótulo inicial da repetição       (padrão: 1; usado pelo CI, uma execução por job)
 *   --label     rótulo da configuração de hardware (padrão: "local")
 *   --spec      glob dos specs                      (padrão: cypress/tests/ui/*.spec.ts)
 *   --browser   navegador                           (padrão: electron)
 *   --out       diretório de saída                  (padrão: experiment-results)
 */
const fs = require("fs");
const path = require("path");
const cypress = require("cypress");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario || "baseline";
const runs = Number(args.runs || 1);
const firstRunId = Number(args["run-id"] || 1);
const label = args.label || "local";
const spec = args.spec || "cypress/tests/ui/*.spec.ts";
const browser = args.browser || "electron";
const outDir = path.resolve(args.out || "experiment-results");

if (!["baseline", "fault", "refactored"].includes(scenario)) {
  console.error(`Cenário inválido: ${scenario}`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

// Lido pelo cypress.config.ts no processo filho do Cypress.
process.env.TEST_SCENARIO = scenario;
process.env.TEST_RETRIES = "0";

async function main() {
  for (let i = 0; i < runs; i++) {
    const runId = firstRunId + i;
    console.log(`\n=== Cenário ${scenario} | ${label} | execução ${runId} ===`);

    const startedAt = new Date();
    const results = await cypress.run({
      browser,
      spec,
      config: { video: false, screenshotOnRunFailure: false },
    });
    const wallClockMs = Date.now() - startedAt.getTime();

    if (results.status === "failed") {
      // O Cypress nem conseguiu executar (ex.: app fora do ar). Não é um resultado de teste.
      console.error(`Falha ao executar o Cypress: ${results.message}`);
      process.exitCode = 1;
      continue;
    }

    const tests = [];
    for (const run of results.runs) {
      for (const test of run.tests) {
        tests.push({
          spec: run.spec.relative,
          title: test.title.join(" > "),
          state: test.state, // passed | failed | pending | skipped
          attempts: (test.attempts || []).length,
          duration: test.duration,
        });
      }
    }

    const record = {
      scenario,
      label,
      runId,
      startedAt: startedAt.toISOString(),
      wallClockMs,
      cypressDurationMs: results.totalDuration,
      totals: {
        tests: results.totalTests,
        passed: results.totalPassed,
        failed: results.totalFailed,
        pending: results.totalPending,
        skipped: results.totalSkipped,
      },
      tests,
    };

    const file = path.join(outDir, `${scenario}__${label}__run${String(runId).padStart(3, "0")}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(
      `→ ${file} (passed ${record.totals.passed}, failed ${record.totals.failed}, ${(
        wallClockMs / 1000
      ).toFixed(1)}s)`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
