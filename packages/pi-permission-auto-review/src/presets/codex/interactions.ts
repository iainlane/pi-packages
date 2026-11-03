import * as v from 'valibot'
import { serializeUnknown } from '../../text.js'

/** A recognised interaction, split so that only the person's response is trusted */
export interface InteractionEvidence {
  /** The question, context and offered options, or the presented plan. The assistant wrote them */
  question: string
  /** The person's response */
  answer: string
  /** Whether the pair is subject to the size limit for answers. A plan approval keeps the presented plan whole */
  limited: boolean
}

interface InteractionAdapter {
  toolName: string
  render: (details: unknown) => InteractionEvidence | undefined
}

const nonEmpty = v.pipe(v.string(), v.minLength(1))

const legacyAnswerSchema = v.object({
  question: nonEmpty,
  answer: v.optional(v.unknown()),
  selected: v.optional(v.unknown()),
  notes: v.optional(v.unknown()),
})

const legacyDetailsSchema = v.object({
  cancelled: v.literal(false),
  answers: v.pipe(v.array(legacyAnswerSchema), v.minLength(1)),
})

const optionSchema = v.object({ title: nonEmpty, description: v.optional(v.string()) })
const questionSchema = v.object({
  question: nonEmpty,
  context: v.optional(v.string()),
  options: v.array(optionSchema),
})
const responseSchema = v.variant('kind', [
  v.object({
    kind: v.literal('selection'),
    selections: v.pipe(v.array(nonEmpty), v.minLength(1)),
    comment: v.optional(v.string()),
  }),
  v.object({ kind: v.literal('freeform'), text: nonEmpty }),
])
const singleDetailsSchema = v.object({
  ...questionSchema.entries,
  response: responseSchema,
  cancelled: v.literal(false),
})
const batchDetailsSchema = v.pipe(
  v.object({
    kind: v.literal('batch'),
    heading: v.optional(v.string()),
    questions: v.pipe(v.array(questionSchema), v.minLength(2), v.maxLength(4)),
    answers: v.array(
      v.variant('status', [
        v.object({ status: v.literal('answered'), response: responseSchema }),
        v.object({ status: v.literal('skipped') }),
      ]),
    ),
    cancelled: v.literal(false),
  }),
  v.check(details => details.questions.length === details.answers.length),
  v.check(details => details.answers.some(answer => answer.status === 'answered')),
)
const askDetailsSchema = v.union([batchDetailsSchema, singleDetailsSchema])
const planRevisionSchema = v.object({ path: nonEmpty, content: nonEmpty, revision: nonEmpty })
const planDetailsSchema = v.pipe(
  v.object({
    decision: v.picklist(['current', 'clear', 'fresh', 'revise', 'cancel']),
    path: nonEmpty,
    revision: nonEmpty,
    presentedPlan: planRevisionSchema,
  }),
  v.check(
    details => details.path === details.presentedPlan.path && details.revision === details.presentedPlan.revision,
  ),
)

type LegacyAnswer = v.InferOutput<typeof legacyAnswerSchema>
type Question = v.InferOutput<typeof questionSchema>
type AskResponse = v.InferOutput<typeof responseSchema>

function adapter<Schema extends v.GenericSchema>(
  toolName: string,
  schema: Schema,
  render: (details: v.InferOutput<Schema>) => InteractionEvidence | undefined,
): InteractionAdapter {
  return {
    toolName,
    render: details => {
      const parsed = v.safeParse(schema, details)

      return parsed.success ? render(parsed.output) : undefined
    },
  }
}

function normalizeAnswer(value: unknown): unknown {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return value
  }

  return Array.isArray(value) ? value.map(normalizeAnswer) : serializeUnknown(value)
}

function legacyAnswer(answer: LegacyAnswer): unknown {
  const primary =
    answer.answer !== undefined && answer.answer !== null
      ? normalizeAnswer(answer.answer)
      : Array.isArray(answer.selected) && answer.selected.length > 0
        ? answer.selected.map(normalizeAnswer)
        : undefined
  const notes = typeof answer.notes === 'string' && answer.notes.length > 0 ? answer.notes : undefined
  if (primary === undefined || notes === undefined) {
    return primary ?? notes
  }

  return { selection: primary, notes }
}

function renderLegacy(details: v.InferOutput<typeof legacyDetailsSchema>): InteractionEvidence | undefined {
  const answers = details.answers.map(legacyAnswer)
  if (answers.includes(undefined)) {
    return undefined
  }

  return {
    question: JSON.stringify(details.answers.map(({ question }) => ({ question }))),
    answer: JSON.stringify(answers.map(answer => ({ answer }))),
    limited: true,
  }
}

function renderResponse(question: Question, response: AskResponse): unknown {
  if (response.kind === 'freeform') {
    return response.text
  }

  return {
    selections: response.selections.map(label =>
      question.options.filter(option => option.title === label).length > 1 ? { label, ambiguous: true } : { label },
    ),
    comment: response.comment,
  }
}

function renderAsk(details: v.InferOutput<typeof askDetailsSchema>): InteractionEvidence {
  if ('kind' in details) {
    return {
      question: JSON.stringify({
        heading: details.heading,
        questions: details.questions.map(({ question, context, options }) => ({ question, context, options })),
      }),
      answer: JSON.stringify(
        details.questions.map((question, index) => {
          const answer = details.answers[index]

          return answer?.status === 'answered'
            ? { answer: renderResponse(question, answer.response) }
            : { skipped: true }
        }),
      ),
      limited: true,
    }
  }

  const { question, context, options } = details

  return {
    question: JSON.stringify([{ question, context, options }]),
    answer: JSON.stringify([{ answer: renderResponse(details, details.response) }]),
    limited: true,
  }
}

const PLAN_CONTEXTS = {
  current: 'in this conversation',
  clear: 'after clearing the context',
  fresh: 'after a handoff to a fresh session',
} as const

function renderPlan(details: v.InferOutput<typeof planDetailsSchema>): InteractionEvidence | undefined {
  if (details.decision !== 'current' && details.decision !== 'clear' && details.decision !== 'fresh') {
    return undefined
  }

  return {
    question: `Plan at ${details.path}, revision ${details.revision}:\n\n${details.presentedPlan.content}`,
    answer: `The user approved implementing this plan revision ${PLAN_CONTEXTS[details.decision]}.`,
    limited: false,
  }
}

/**
 * Tools whose structured result details record a person's response. Each adapter decodes the details with a schema
 * and renders only the validated fields
 */
export const INTERACTION_ADAPTERS: readonly InteractionAdapter[] = [
  adapter('ask_user_question', legacyDetailsSchema, renderLegacy),
  adapter('plan_mode_question', legacyDetailsSchema, renderLegacy),
  adapter('ask_user', askDetailsSchema, renderAsk),
  adapter('submit_plan', planDetailsSchema, renderPlan),
]
