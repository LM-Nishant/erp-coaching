import { describe, expect, it } from 'vitest';
import { greetingFor } from './teacher-home';

describe('teacher home', () => {
  it('greets by the time of day', () => {
    expect([greetingFor(8), greetingFor(13), greetingFor(19)]).toEqual(['morning', 'afternoon', 'evening']);
  });
});
