import { describe, expect, it } from 'vitest';
import { quizProblem, type QuizDraftQuestion } from './quiz-draft';

const q = (over: Partial<QuizDraftQuestion> = {}): QuizDraftQuestion => ({
  uid: 1,
  kind: 'single',
  prompt: 'Pick one',
  options: [
    { key: 'A', text: 'Yes' },
    { key: 'B', text: 'No' },
  ],
  correct: ['A'],
  explanation: '',
  ...over,
});

describe('quiz draft checks', () => {
  it('accepts a complete quiz and names the first problem otherwise', () => {
    expect(quizProblem([q(), q({ kind: 'multi', correct: ['A', 'B'] })], 70)).toBeNull();
    expect(quizProblem([q()], 0)).toMatch(/pass mark/);
    expect(quizProblem([q(), q({ prompt: ' ' })], 70)).toBe('Question 2 needs its question text.');
    expect(quizProblem([q({ options: [{ key: 'A', text: '' }] })], 70)).toMatch(/empty option/);
    expect(quizProblem([q({ correct: [] })], 70)).toMatch(/needs a correct answer/);
    expect(quizProblem([q({ correct: ['A', 'B'] })], 70)).toMatch(/only have one/);
  });
});
