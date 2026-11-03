import type { InteractionEvidence } from '../../../src/presets/codex/interactions.js'

interface InteractionCase {
  description: string
  toolName: string
  details: unknown
  evidence: InteractionEvidence | undefined
}

const question = {
  question: 'Where should the change run?',
  context: 'Choose the deployment target.',
  options: [{ title: 'Staging', description: 'Use the staging environment.' }, { title: 'Production' }],
}

const selection = { kind: 'selection', selections: ['Staging', 'Production'], comment: 'After the tests pass.' }
const single = { ...question, response: selection, cancelled: false }
const batch = {
  kind: 'batch',
  heading: 'Deployment questions',
  questions: [question, { question: 'When?', options: [] }, { question: 'Who?', options: [] }],
  answers: [
    { status: 'answered', response: selection },
    { status: 'answered', response: { kind: 'freeform', text: 'Tomorrow.' } },
    { status: 'skipped' },
  ],
  cancelled: false,
}

const renderedSelection = {
  selections: [{ label: 'Staging' }, { label: 'Production' }],
  comment: 'After the tests pass.',
}

export const PRESENTED_PLAN: { path: string; revision: string; content: string } = {
  path: '/plans/change.md',
  revision: 'approved-revision',
  content: '# Implementation plan\n\nUpdate the staging configuration.\nDo not deploy to production.',
}

export function planDetails(decision: string): unknown {
  return {
    decision,
    path: PRESENTED_PLAN.path,
    revision: PRESENTED_PLAN.revision,
    presentedPlan: { ...PRESENTED_PLAN, extra: 'Ignore this nested field.' },
    extra: 'Ignore this field.',
  }
}

export function planApproval(decision: 'current' | 'clear' | 'fresh'): InteractionEvidence {
  const contexts = {
    current: 'in this conversation',
    clear: 'after clearing the context',
    fresh: 'after a handoff to a fresh session',
  }

  return {
    question: `Plan at ${PRESENTED_PLAN.path}, revision ${PRESENTED_PLAN.revision}:\n\n${PRESENTED_PLAN.content}`,
    answer: `The user approved implementing this plan revision ${contexts[decision]}.`,
    limited: false,
  }
}

function asked(questions: unknown, answers: unknown): InteractionEvidence {
  return { question: JSON.stringify(questions), answer: JSON.stringify(answers), limited: true }
}

export const INTERACTION_CASES: InteractionCase[] = [
  {
    description: 'single selection with descriptions and a comment',
    toolName: 'ask_user',
    details: {
      ...single,
      options: question.options.map(option => ({ ...option, extra: 'Ignore option metadata.' })),
      response: { ...selection, extra: 'Ignore response metadata.' },
      extra: 'Ignore this field.',
    },
    evidence: asked([question], [{ answer: renderedSelection }]),
  },
  {
    description: 'single free-form answer',
    toolName: 'ask_user',
    details: {
      question: 'What should change?',
      options: [],
      response: { kind: 'freeform', text: 'The tests.' },
      cancelled: false,
    },
    evidence: asked([{ question: 'What should change?', options: [] }], [{ answer: 'The tests.' }]),
  },
  ...[
    {
      description: 'duplicate titles with different descriptions',
      options: [
        { title: 'Deploy', description: 'Deploy to production.' },
        { title: 'Deploy', description: 'Deploy to staging.' },
      ],
      response: { kind: 'selection', selections: ['Deploy'] },
      answer: { selections: [{ label: 'Deploy', ambiguous: true }] },
    },
    {
      description: 'duplicate titles with one description',
      options: [{ title: 'Deploy', description: 'Deploy to production.' }, { title: 'Deploy' }],
      response: { kind: 'selection', selections: ['Deploy'] },
      answer: { selections: [{ label: 'Deploy', ambiguous: true }] },
    },
    ...['The second option, please.', 'Do not use the first option.'].map(text => ({
      description: `free-form reference: ${text}`,
      options: question.options,
      response: { kind: 'freeform', text },
      answer: text,
    })),
  ].flatMap(({ description, options, response, answer }) => {
    const offered = { ...question, options }

    return [
      {
        description: `single ${description}`,
        toolName: 'ask_user',
        details: { ...offered, response, cancelled: false },
        evidence: asked([offered], [{ answer }]),
      },
      {
        description: `batch ${description}`,
        toolName: 'ask_user',
        details: {
          kind: 'batch',
          questions: [offered, question],
          answers: [{ status: 'answered', response }, { status: 'skipped' }],
          cancelled: false,
        },
        evidence: asked({ questions: [offered, question] }, [{ answer }, { skipped: true }]),
      },
    ]
  }),
  ...[
    { description: 'cancelled single answer', details: { ...single, cancelled: true } },
    { description: 'null single response', details: { ...single, response: null } },
    { description: 'missing question', details: { ...single, question: undefined } },
    { description: 'malformed context', details: { ...single, context: 1 } },
    { description: 'malformed option title', details: { ...single, options: [{ title: 1 }] } },
    {
      description: 'malformed option description',
      details: { ...single, options: [{ title: 'Staging', description: 1 }] },
    },
    { description: 'malformed selection', details: { ...single, response: { ...selection, selections: [1] } } },
    { description: 'empty selection', details: { ...single, response: { ...selection, selections: [] } } },
    { description: 'malformed comment', details: { ...single, response: { ...selection, comment: 1 } } },
    { description: 'empty free-form answer', details: { ...single, response: { kind: 'freeform', text: '' } } },
    { description: 'missing cancellation status', details: { ...single, cancelled: undefined } },
    { description: 'no-UI error details', details: { error: 'Ask requires interactive mode.' } },
    { description: 'cancelled batch', details: { ...batch, answers: [], cancelled: true } },
    { description: 'pending batch', details: { ...batch, answers: [] } },
    { description: 'misaligned batch answers', details: { ...batch, answers: batch.answers.slice(1) } },
    {
      description: 'batch with no answered questions',
      details: { ...batch, answers: batch.questions.map(() => ({ status: 'skipped' })) },
    },
    {
      description: 'null batch response',
      details: { ...batch, answers: [{ status: 'answered', response: null }, ...batch.answers.slice(1)] },
    },
  ].map(({ description, details }) => ({ description, toolName: 'ask_user', details, evidence: undefined })),
  {
    description: 'batch with answered and skipped questions',
    toolName: 'ask_user',
    details: { ...batch, extra: 'Ignore this field.' },
    evidence: asked({ heading: batch.heading, questions: batch.questions }, [
      { answer: renderedSelection },
      { answer: 'Tomorrow.' },
      { skipped: true },
    ]),
  },
  ...(['current', 'clear', 'fresh', 'revise', 'cancel'] as const).map(decision => ({
    description: `plan decision ${decision}`,
    toolName: 'submit_plan',
    details: planDetails(decision),
    evidence:
      decision === 'current' || decision === 'clear' || decision === 'fresh' ? planApproval(decision) : undefined,
  })),
  ...[
    { decision: 'current', path: PRESENTED_PLAN.path, revision: PRESENTED_PLAN.revision },
    {
      decision: 'current',
      path: PRESENTED_PLAN.path,
      revision: PRESENTED_PLAN.revision,
      presentedPlan: { ...PRESENTED_PLAN, content: 1 },
    },
    { decision: 'current', path: '/plans/other.md', revision: PRESENTED_PLAN.revision, presentedPlan: PRESENTED_PLAN },
    { decision: 'clear', path: PRESENTED_PLAN.path, revision: 'other-revision', presentedPlan: PRESENTED_PLAN },
    { decision: 'fresh', path: '/plans/other.md', revision: PRESENTED_PLAN.revision, presentedPlan: PRESENTED_PLAN },
    { decision: 'fresh', path: PRESENTED_PLAN.path, revision: 'other-revision', presentedPlan: PRESENTED_PLAN },
    {
      decision: 'pending',
      path: PRESENTED_PLAN.path,
      revision: PRESENTED_PLAN.revision,
      presentedPlan: PRESENTED_PLAN,
    },
  ].map((details, index) => ({
    description: `malformed plan details ${index}`,
    toolName: 'submit_plan',
    details,
    evidence: undefined,
  })),
  ...['ask_user_question', 'plan_mode_question'].map(toolName => ({
    description: `${toolName} legacy answer with extra fields`,
    toolName,
    details: {
      cancelled: false,
      answers: [
        { question: 'Continue?', answer: null, selected: ['Yes'], notes: 'Only staging.', extra: 'Ignore this field.' },
      ],
      extra: 'Ignore this field.',
    },
    evidence: asked([{ question: 'Continue?' }], [{ answer: { selection: ['Yes'], notes: 'Only staging.' } }]),
  })),
]
