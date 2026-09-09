import { parse } from "yaml";

export interface ParsedFrontmatter<T extends Record<string, unknown>> {
  frontmatter: T;
  body: string;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isFrontmatterRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFrontmatter(content: string): { yamlString: string | null; body: string } {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith("---\n")) {
    return { yamlString: null, body: normalized };
  }

  const remainder = normalized.slice(4);
  const closingDelimiter = /(?:^|\n)---(?:\n|$)/.exec(remainder);
  if (!closingDelimiter) {
    return { yamlString: null, body: normalized };
  }

  return {
    yamlString: remainder.slice(0, closingDelimiter.index),
    body: remainder.slice(closingDelimiter.index + closingDelimiter[0].length).trim(),
  };
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
): ParsedFrontmatter<T> {
  const { yamlString, body } = extractFrontmatter(content);
  if (!yamlString) {
    return { frontmatter: {} as T, body };
  }

  const parsed: unknown = parse(yamlString);
  return { frontmatter: (isFrontmatterRecord(parsed) ? parsed : {}) as T, body };
}

export function stripFrontmatter(content: string): string {
  return parseFrontmatter(content).body;
}
