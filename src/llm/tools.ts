import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

/**
 * Tool definitions for the correlation agent, in Anthropic's tool format.
 * `submit_report` is how the agent returns its answer — the loop keeps going
 * until the model calls it, which keeps free-text parsing out of the hot path.
 */
export const CORRELATION_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'inspect_change',
    description:
      'Fetch the files touched, diff size, and description for one candidate change. Use the exact id from the candidate list (e.g. "pr:482").',
    input_schema: {
      type: 'object' as const,
      properties: {
        change_id: { type: 'string', description: 'Change id from the candidate list, e.g. "pr:482" or "deploy:99182".' },
      },
      required: ['change_id'],
    },
  },
  {
    name: 'find_changes_touching',
    description:
      'Find which candidate changes touched files whose path contains the given substring. Use this when the symptom points at a subsystem (e.g. "checkout", "migrations/", "nginx").',
    input_schema: {
      type: 'object' as const,
      properties: {
        path_substring: { type: 'string', description: 'Case-insensitive substring to match against changed file paths.' },
      },
      required: ['path_substring'],
    },
  },
  {
    name: 'submit_report',
    description: 'Return the final correlation report. Call this exactly once, when the investigation is complete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description:
            'Two to four sentences for responders in Slack: what you looked at, and what the leading suspect is (or that there is none).',
        },
        findings: {
          type: 'array',
          description: 'Changes worth a responder\'s attention, most likely first. Omit changes you ruled out.',
          items: {
            type: 'object',
            properties: {
              change_id: { type: 'string' },
              likelihood: { type: 'string', enum: ['high', 'medium', 'low'] },
              reasoning: {
                type: 'string',
                description: 'One or two sentences citing what you observed — file paths, diff size, timing.',
              },
            },
            required: ['change_id', 'likelihood', 'reasoning'],
          },
        },
        suggested_checks: {
          type: 'array',
          description: 'Concrete next steps for the responders: dashboards to open, a revert to consider, a query to run.',
          items: { type: 'string' },
        },
      },
      required: ['summary', 'findings', 'suggested_checks'],
    },
  },
];

export const submitReportSchema = z.object({
  summary: z.string().min(1),
  findings: z
    .array(
      z.object({
        change_id: z.string().min(1),
        likelihood: z.enum(['high', 'medium', 'low']),
        reasoning: z.string().min(1),
      }),
    )
    .default([]),
  suggested_checks: z.array(z.string()).default([]),
});

export const POSTMORTEM_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'submit_postmortem',
    description: 'Return the postmortem draft.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'GitHub issue title. Start with the incident key.' },
        markdown: {
          type: 'string',
          description:
            'The full postmortem in GitHub-flavored Markdown, with ## sections: Summary, Impact, Timeline, Root Cause, Contributing Factors, What Went Well, Action Items.',
        },
        labels: {
          type: 'array',
          description: 'GitHub labels, e.g. ["postmortem", "sev2"].',
          items: { type: 'string' },
        },
      },
      required: ['title', 'markdown', 'labels'],
    },
  },
];

export const submitPostmortemSchema = z.object({
  title: z.string().min(1),
  markdown: z.string().min(1),
  labels: z.array(z.string()).default([]),
});
