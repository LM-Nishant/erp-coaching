import { describe, expect, it } from 'vitest';
import { widgetTitleKey } from './widget-title';

describe('widgetTitleKey', () => {
  it('maps a widget id to its module namespace', () => {
    expect(widgetTitleKey('live-classes.next')).toBe('liveClasses.widgets.next');
    expect(widgetTitleKey('exams.latestResult')).toBe('exams.widgets.latestResult');
    expect(widgetTitleKey('parent-portal.schedule')).toBe('parentPortal.widgets.schedule');
  });
});
