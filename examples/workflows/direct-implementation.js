/**
 * Caller supplies an approved TaskPlan to SubagentWorkflow and args.task (the
 * bounded implementation/acceptance instructions). No role/config defaults.
 * For recovery, also pass recoveryCheckpointId and args.continueFromCheckpoint:
 * true. The host revalidates it; the recipe reads its actual safeStep.
 * Fresh Builders on repair avoid depending on a retained conversation handle.
 */
export const meta = {
  name: 'direct-implementation',
  description: 'Serial approved implementation, local checks and fresh independent review',
  phases: [{ title: 'Build' }, { title: 'Check' }, { title: 'Review' }],
}

if (typeof task === 'undefined') throw new Error('Direct implementation requires an approved TaskPlan.')
if (typeof args?.task !== 'string' || !args.task.trim()) throw new Error('Declare bounded task instructions in args.task.')

// Matches TaskReviewSchema; the host additionally checks consistency, actual
// structured output, freshness and exact candidate binding.
const text = { type: 'string', minLength: 1, pattern: '\\S' }
const reviewSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    version: { const: 1, type: 'number' }, status: { const: 'COMPLETE', type: 'string' },
    candidateFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    verdict: { anyOf: [{ const: 'PASS', type: 'string' }, { const: 'REJECT', type: 'string' }] },
    summary: text,
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { id: text, severity: { anyOf: ['P0', 'P1', 'P2', 'P3'].map(value => ({ const: value, type: 'string' })) }, path: text, description: text },
      required: ['id', 'severity', 'path', 'description'],
    } },
  },
  required: ['version', 'status', 'candidateFingerprint', 'verdict', 'findings', 'summary'],
}

let state = args.continueFromCheckpoint === true ? await task.checkpoint() : null
let repair = ''
while (true) {
  if (state === null || state.safeStep === 'reopened') {
    if (state !== null) {
      const context = state.remediation
      if (!context || typeof context.reason !== 'string' || !context.reason.trim()
        || context.sourceFingerprint !== state.sourceFingerprint || context.remediations !== state.remediations || state.remediations < 1) {
        throw new Error('Reopened checkpoint remediation context is missing or invalid; Human-owned handoff required.')
      }
      repair = context.reason
    }
    phase('Build')
    const assignment = await task.prepare('builder')
    const result = await agent(
      `${args.task}\nExecute only the prepared Builder contract. No publication, installation or cleanup.\n${repair || 'Use the assigned instructions and evidence; do not widen scope.'}`,
      { label: `builder:${assignment.attemptId}`, agentType: assignment.profile, taskAssignment: assignment },
    )
    if (typeof result !== 'string' || !result.trim()) throw new Error('Builder result missing or malformed; no local readiness claim.')
    state = await task.checkpoint()
  }
  if (state.safeStep === 'built' || state.safeStep === 'checked') {
    phase('Check')
    // Await every approved check; continuation skips already recorded commands.
    for (const command of state.plan.builder.approvedChecks) {
      if (!state.checks.some(check => check.command === command)) await task.check(command)
    }
    state = await task.checkpoint()
    const failed = state.checks.filter(check => !check.ok)
    if (failed.length) {
      repair = `Repair only these actual check failures:\n${JSON.stringify(failed)}`
      state = await task.reopen(repair) // Host owns the shared remediation bound.
      continue
    }
    state = await task.freeze()
  }
  if (state.safeStep === 'frozen') {
    phase('Review')
    const assignment = await task.prepare('reviewer')
    const verdict = await agent(
      `${args.task}\nIndependently review the exact frozen candidate ${state.candidate.fingerprint}.\nDo not author source. Cover the approved contract and edge cases; report COMPLETE only after coverage.\nCandidate/check evidence: ${JSON.stringify({ candidate: state.candidate, checks: state.checks })}`,
      { label: `reviewer:${assignment.attemptId}`, agentType: assignment.profile, taskAssignment: assignment, schema: reviewSchema },
    )
    if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) throw new Error('Reviewer result missing or malformed; no local readiness claim.')
    state = await task.recordReview(verdict)
  }
  if (state.safeStep !== 'reviewed') throw new Error(`Unsupported Direct checkpoint step: ${state.safeStep}`)
  if (state.review.verdict.verdict === 'REJECT') {
    repair = `Address only the COMPLETE independent review findings:\n${JSON.stringify(state.review.verdict)}`
    state = await task.reopen(repair)
    continue
  }
  if (state.review.verdict.verdict !== 'PASS') throw new Error('No COMPLETE PASS review.')
  state = await task.checkpoint()
  return {
    status: 'locally-ready-for-human', mergeApproval: false,
    candidate: state.candidate, checks: state.checks.map(check => ({ command: check.command, ok: check.ok, artifact: check.artifact })),
    review: { verdict: state.review.verdict, artifact: state.review.artifact },
    checkpoint: state.checkpoint, safeStep: state.safeStep, remediations: state.remediations,
    attempts: state.attempts.map(attempt => ({ role: attempt.role, attemptId: attempt.assignment.attemptId,
      agentId: attempt.agentId, receiptAttempt: attempt.receipt.attempt, profile: attempt.receipt.profile,
      model: attempt.receipt.effective.model, effort: attempt.receipt.effective.thinking,
      usage: attempt.receipt.usage, sdkDisposition: attempt.receipt.sdk.disposition })),
    // The checkpoint's private projection retains full receipts and artifacts;
    // no source/transcript bytes or repeated role contracts in this summary.
  }
}
