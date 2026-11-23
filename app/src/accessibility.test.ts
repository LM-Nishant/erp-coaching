// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'vue/compiler-sfc';

/**
 * Guards against icon-only controls without an accessible name. An `<ion-button>` whose only
 * content is `<ion-icon slot="icon-only">` renders a native button with no text, so screen
 * readers announce just "button". Every button or link without visible text needs an
 * `aria-label` (static or bound) or `aria-labelledby`. Ionic forwards it to the native element.
 */

// @vue/compiler-core NodeTypes.
const ELEMENT = 1;
const TEXT = 2;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;

interface TemplateNode {
  type: number;
  tag: string;
  content?: unknown;
  props: { type: number; name: string; value?: { content: string }; arg?: { content?: string } | null }[];
  children?: TemplateNode[];
  loc: { start: { line: number } };
}

const CONTROLS = new Set([
  'a',
  'button',
  'router-link',
  'ion-button',
  'ion-fab-button',
  'ion-segment-button',
  'ion-tab-button',
]);
const NAME_ATTRIBUTES = new Set(['aria-label', 'aria-labelledby']);
const SRC = fileURLToPath(new URL('.', import.meta.url));

const kebab = (tag: string) => tag.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return vueFiles(path);
    return entry.name.endsWith('.vue') ? [path] : [];
  });
}

function hasName(el: TemplateNode): boolean {
  return el.props.some((p) =>
    p.type === ATTRIBUTE
      ? NAME_ATTRIBUTES.has(p.name) && !!p.value?.content.trim()
      : p.type === DIRECTIVE && p.name === 'bind' && NAME_ATTRIBUTES.has(p.arg?.content ?? ''),
  );
}

/** Whether the element renders text: static text, an interpolation, v-text/v-html, an image alt or a slot. */
function hasText(el: TemplateNode): boolean {
  return (el.children ?? []).some((child) => {
    if (child.type === TEXT) return typeof child.content === 'string' && child.content.trim() !== '';
    if (child.type === INTERPOLATION) return true;
    if (child.type !== ELEMENT) return false;
    if (child.tag === 'slot') return true;
    const directive = (name: string) => child.props.some((p) => p.type === DIRECTIVE && p.name === name);
    if (directive('text') || directive('html')) return true;
    if (child.tag === 'img' && child.props.some((p) => p.name === 'alt' || p.arg?.content === 'alt'))
      return true;
    return hasText(child);
  });
}

function unnamedControls(node: TemplateNode, found: number[] = []): number[] {
  if (node.type === ELEMENT) {
    const tag = kebab(node.tag);
    const clickableIcon =
      tag === 'ion-icon' && node.props.some((p) => p.type === DIRECTIVE && p.name === 'on');
    if ((clickableIcon || (CONTROLS.has(tag) && !hasText(node))) && !hasName(node))
      found.push(node.loc.start.line);
  }
  for (const child of node.children ?? []) unnamedControls(child, found);
  return found;
}

describe('icon-only controls', () => {
  it('every button or link without visible text has an aria-label', () => {
    const files = vueFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((file) => {
      const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file });
      const ast = descriptor.template?.ast as unknown as TemplateNode | undefined;
      return ast ? unnamedControls(ast).map((line) => `${relative(SRC, file)}:${line}`) : [];
    });
    expect(offenders, 'add an aria-label to these icon-only controls').toEqual([]);
    // Parses every .vue file; slow when the whole suite runs in parallel.
  }, 30_000);

  it('flags an icon-only button without a label', () => {
    const sfc = (body: string) => {
      const ast = parse(`<template>${body}</template>`).descriptor.template!.ast as unknown as TemplateNode;
      return unnamedControls(ast).length;
    };
    expect(sfc('<ion-button @click="go"><ion-icon slot="icon-only" :icon="add" /></ion-button>')).toBe(1);
    expect(sfc('<ion-icon :icon="close" @click="go" />')).toBe(1);
    expect(
      sfc('<ion-button aria-label="Add" @click="go"><ion-icon slot="icon-only" :icon="add" /></ion-button>'),
    ).toBe(0);
    expect(sfc('<ion-button :aria-label="`Edit ${name}`"><ion-icon slot="icon-only" /></ion-button>')).toBe(
      0,
    );
    expect(sfc('<ion-button><ion-icon slot="start" />{{ label }}</ion-button>')).toBe(0);
  });
});
