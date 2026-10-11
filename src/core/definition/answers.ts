import { ConfigError } from '../../errors/index.js';
import type { Manifest, Question, When } from './manifest.js';

/** The part of a manifest that answering needs. A composition of several definitions satisfies it too. */
export type QuestionSet = Pick<Manifest, 'id' | 'questions'>;

export type AnswerValue = string | boolean | number | null;
export type Answers = Readonly<Record<string, AnswerValue>>;
/** Raw answers as supplied by flags or config: strings (from the command line) or typed values. */
export type RawAnswers = Readonly<Record<string, string | boolean>>;

export function evaluateWhen(when: When | undefined, answers: Answers): boolean {
  if (when === undefined) return true;
  const actual = answers[when.answer];
  const matches =
    when.equals !== undefined
      ? actual === when.equals
      : when.in !== undefined
        ? when.in.some((candidate) => candidate === actual)
        : actual !== null && actual !== undefined && actual !== false && actual !== '';
  return when.not === true ? !matches : matches;
}

function fail(message: string, hint?: string): ConfigError {
  return new ConfigError(message, { code: 'FORGE_E_ANSWER_INVALID', ...(hint === undefined ? {} : { hint }) });
}

/** Validate one raw answer against its question and return the typed value. */
export function validateAnswer(question: Question, raw: string | boolean): AnswerValue {
  if (question.type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw fail(`Answer "${question.id}" must be true or false but got ${JSON.stringify(raw)}.`);
  }
  if (typeof raw !== 'string') throw fail(`Answer "${question.id}" must be text.`);
  if (question.type === 'enum') {
    if (!question.choices.includes(raw)) {
      throw fail(`Answer "${question.id}" must be one of ${question.choices.join(', ')} but got ${JSON.stringify(raw)}.`);
    }
    return raw;
  }
  if (question.pattern !== undefined && !new RegExp(question.pattern).test(raw)) {
    throw fail(`Answer "${question.id}" does not match the required pattern ${question.pattern}.`);
  }
  return raw;
}

export interface ResolveAnswersOptions {
  /** Fill in defaults for questions that have one. Without it, every answer must be supplied. */
  readonly useDefaults: boolean;
}

/**
 * Turn raw answers into a complete, validated answer set.
 * Questions skipped by a `when` condition resolve to null so strict templates can still read them.
 */
export function resolveAnswers(manifest: QuestionSet, provided: RawAnswers, options: ResolveAnswersOptions): Answers {
  const known = new Set(manifest.questions.map((q) => q.id));
  for (const key of Object.keys(provided)) {
    if (!known.has(key)) {
      throw fail(
        `Unknown answer "${key}" for "${manifest.id}".`,
        known.size === 0 ? 'This definition asks no questions.' : `Known answers: ${[...known].join(', ')}.`,
      );
    }
  }
  const answers: Record<string, AnswerValue> = {};
  for (const question of manifest.questions) {
    if (!evaluateWhen(question.when, answers)) {
      answers[question.id] = null;
      continue;
    }
    const supplied = provided[question.id];
    if (supplied !== undefined) {
      answers[question.id] = validateAnswer(question, supplied);
      continue;
    }
    if (options.useDefaults && question.default !== undefined) {
      answers[question.id] = question.default;
      continue;
    }
    if (question.required === false) {
      answers[question.id] = null;
      continue;
    }
    throw fail(
      `Missing answer "${question.id}" (${question.message}).`,
      `Pass --answer ${question.id}=<value>${question.default === undefined ? '' : ' or use --yes to accept the default'}.`,
    );
  }
  return answers;
}

/** Answers that are safe to persist: secrets are never written to state. */
export function persistableAnswers(manifest: QuestionSet, answers: Answers): Answers {
  const secret = new Set(manifest.questions.filter((q) => q.secret === true).map((q) => q.id));
  return Object.fromEntries(Object.entries(answers).filter(([key]) => !secret.has(key)));
}
