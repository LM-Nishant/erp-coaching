import { describe, expect, it } from 'vitest';
import { greetingFor, widgetTitleKey } from './teacher-home';

describe('teacher home', () => {
  it('greets by the time of day', () => {
    expect([greetingFor(8), greetingFor(13), greetingFor(19)]).toEqual(['morning', 'afternoon', 'evening']);
  });

  it('finds the title key of a widget id', () => {
    expect(widgetTitleKey('live-classes.teacher-today')).toBe('liveClasses.widgets.teacherToday');
  });
});
