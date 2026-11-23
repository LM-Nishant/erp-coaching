import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import FormSection from './FormSection.vue';
import QuickActions from './QuickActions.vue';
import EmptyState from './EmptyState.vue';

const push = vi.fn();
vi.mock('@ionic/vue', async (orig) => ({ ...(await orig<object>()), useIonRouter: () => ({ push }) }));

describe('shared components', () => {
  it('FormSection hides advanced fields until asked', async () => {
    const w = mount(FormSection, {
      props: { advanced: true },
      slots: { default: '<input id="rare" />' },
      global: { plugins: [i18n] },
    });
    expect(w.find('#rare').exists()).toBe(false);
    expect(w.find('button').text()).toBe('Show more options');
    await w.find('button').trigger('click');
    expect(w.find('#rare').exists()).toBe(true);
    expect(w.find('button').attributes('aria-expanded')).toBe('true');
  });

  it('QuickActions opens the route or runs the handler, and shows non-zero badges', async () => {
    const onClick = vi.fn();
    const w = mount(QuickActions, {
      props: {
        actions: [
          { id: 'a.route', title: 'Collect fee', icon: '', to: '/fees/accounts' },
          { id: 'a.click', title: 'Doubts', icon: '', onClick, badge: 5 },
          { id: 'a.zero', title: 'Zero', icon: '', badge: 0 },
        ],
      },
    });
    const buttons = w.findAll('button');
    await buttons[0].trigger('click');
    await buttons[1].trigger('click');
    expect(push).toHaveBeenCalledWith('/fees/accounts');
    expect(onClick).toHaveBeenCalled();
    expect(w.findAll('.badge').map((b) => b.text())).toEqual(['5']);
  });

  it('EmptyState renders the next step', () => {
    const w = mount(EmptyState, {
      props: { title: 'No students yet' },
      slots: { default: '<button>Add student</button>' },
    });
    expect(w.text()).toContain('No students yet');
    expect(w.find('.actions button').text()).toBe('Add student');
  });
});
