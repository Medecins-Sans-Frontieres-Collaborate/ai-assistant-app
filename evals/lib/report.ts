import { costRatio, formatUsd } from './cost';
import type {
  CaseComparison,
  EvalReport,
  RunResult,
  StrategySummary,
  TurnJudgement,
} from './types';

interface JudgeOutcomeLike {
  judgements: TurnJudgement[];
  judgeCostUsd: number;
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

export function compareCase(
  goal: RunResult,
  candidate: RunResult,
  judged: JudgeOutcomeLike,
  costCeiling: number,
): CaseComparison {
  const js = judged.judgements;
  const wins = js.reduce(
    (s, j) =>
      s + (j.preference === 'candidate' ? 1 : j.preference === 'tie' ? 0.5 : 0),
    0,
  );
  const ratio = costRatio(candidate.totalCostUsd, goal.totalCostUsd);
  return {
    caseId: goal.caseId,
    goal,
    candidate,
    judgements: js,
    meanParity: mean(js.map((j) => j.parity)),
    candidateWinRate: js.length ? wins / js.length : 0,
    costRatio: ratio,
    judgeCostUsd: judged.judgeCostUsd,
    overBudget: ratio > costCeiling,
  };
}

export function summarizeStrategy(
  strategyId: string,
  modelId: string,
  cases: CaseComparison[],
): StrategySummary {
  const finite = cases.map((c) => c.costRatio).filter(Number.isFinite);
  return {
    strategyId,
    modelId,
    cases,
    meanParity: mean(cases.map((c) => c.meanParity)),
    meanWinRate: mean(cases.map((c) => c.candidateWinRate)),
    meanCostRatio:
      finite.length === cases.length ? mean(finite) : Number.POSITIVE_INFINITY,
    overBudgetCases: cases.filter((c) => c.overBudget).length,
    totalCandidateCostUsd: cases.reduce(
      (s, c) => s + c.candidate.totalCostUsd,
      0,
    ),
    totalGoalCostUsd: cases.reduce((s, c) => s + c.goal.totalCostUsd, 0),
    totalJudgeCostUsd: cases.reduce((s, c) => s + c.judgeCostUsd, 0),
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const ratio = (n: number): string =>
  Number.isFinite(n) ? `${n.toFixed(2)}×` : '∞';

export function renderMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Model parity report`);
  lines.push('');
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(
    `- Goal model: \`${report.goalModelId}\` (strategy \`${report.goalStrategyId}\`)`,
  );
  lines.push(`- Aspirational model: \`${report.aspirationalModelId}\``);
  lines.push(`- Judge: \`${report.judgeModelId}\``);
  lines.push(
    `- Cost ceiling: candidate ≤ ${ratio(report.costCeiling)} goal cost per case`,
  );
  lines.push('');
  lines.push('## Strategies');
  lines.push('');
  lines.push(
    '| Strategy | Parity (0–10) | Win rate vs goal | Cost ratio | Over budget | Candidate $ | Goal $ | Judge $ |',
  );
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of [...report.strategies].sort(
    (a, b) => b.meanParity - a.meanParity,
  )) {
    lines.push(
      `| \`${s.strategyId}\` | ${s.meanParity.toFixed(2)} | ${pct(s.meanWinRate)} | ${ratio(s.meanCostRatio)} | ${s.overBudgetCases}/${s.cases.length} | ${formatUsd(s.totalCandidateCostUsd)} | ${formatUsd(s.totalGoalCostUsd)} | ${formatUsd(s.totalJudgeCostUsd)} |`,
    );
  }
  lines.push('');
  lines.push(
    "> Parity and win rate are judged per turn against the goal model's answer; cost ratio counts every model call the strategy made (plans, self-reviews, …), so agentic recipes pay for their extra rounds here.",
  );

  for (const s of report.strategies) {
    lines.push('');
    lines.push(`## \`${s.strategyId}\``);
    lines.push('');
    lines.push(
      '| Case | Turns | Parity | Win rate | Cost ratio | Candidate $ | Goal $ | Note |',
    );
    lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
    for (const c of s.cases) {
      const note = c.candidate.error
        ? `ERROR: ${c.candidate.error}`
        : c.overBudget
          ? '⚠ over budget'
          : '';
      lines.push(
        `| ${c.caseId} | ${c.candidate.turns.length}/${c.goal.turns.length} | ${c.meanParity.toFixed(1)} | ${pct(c.candidateWinRate)} | ${ratio(c.costRatio)} | ${formatUsd(c.candidate.totalCostUsd)} | ${formatUsd(c.goal.totalCostUsd)} | ${note} |`,
      );
    }
    for (const c of s.cases) {
      const weakest = [...c.judgements].sort((a, b) => a.parity - b.parity)[0];
      if (!weakest) continue;
      lines.push('');
      lines.push(
        `- **${c.caseId}** weakest turn ${weakest.turnIndex + 1}: parity ${weakest.parity}, ` +
          `acc ${weakest.dimensions.accuracy} / comp ${weakest.dimensions.completeness} / fmt ${weakest.dimensions.formatting} / conc ${weakest.dimensions.concision} — ${weakest.rationale}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
