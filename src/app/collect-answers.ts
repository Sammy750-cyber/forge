import { evaluateWhen, validateAnswer, type AnswerValue, type QuestionSet, type RawAnswers } from '../core/definition/answers.js';
import type { Question } from '../core/definition/manifest.js';
import { ConfigError } from '../errors/index.js';
import type { Prompter } from '../ports/index.js';

const MAX_ATTEMPTS = 3;

async function ask(question: Question, prompter: Prompter): Promise<string | boolean> {
  switch (question.type) {
    case 'boolean':
      return prompter.confirm(question.message, { default: question.default ?? false });
    case 'enum':
      return prompter.select(question.message, question.choices, question.default === undefined ? {} : { default: question.default });
    case 'string':
      return prompter.text(question.message, {
        ...(question.default === undefined ? {} : { default: question.default }),
        ...(question.secret === true ? { secret: true } : {}),
      });
  }
}

/**
 * Ask for every answer that was not supplied up front. Questions are asked in manifest order and
 * skipped when their `when` condition is not met, exactly as resolveAnswers will evaluate them.
 * Invalid input is explained and re-asked, up to three times.
 */
export async function collectAnswers(manifest: QuestionSet, provided: RawAnswers, prompter: Prompter): Promise<RawAnswers> {
  const raw: Record<string, string | boolean> = { ...provided };
  const typed: Record<string, AnswerValue> = {};

  for (const question of manifest.questions) {
    if (!evaluateWhen(question.when, typed)) {
      typed[question.id] = null;
      continue;
    }
    const supplied = raw[question.id];
    if (supplied !== undefined) {
      typed[question.id] = validateAnswer(question, supplied);
      continue;
    }
    for (let attempt = 1; ; attempt += 1) {
      const answer = await ask(question, prompter);
      if (question.type === 'string' && answer === '' && question.required === false) {
        typed[question.id] = null;
        break;
      }
      try {
        typed[question.id] = validateAnswer(question, answer);
        raw[question.id] = answer;
        break;
      } catch (error) {
        if (!(error instanceof ConfigError) || attempt >= MAX_ATTEMPTS) throw error;
        prompter.warn(error.message);
      }
    }
  }
  return raw;
}
