import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/slack/parseCommand.js';
import { UsageError } from '../src/util/errors.js';

describe('parseCommand', () => {
  describe('declare', () => {
    it('defaults to sev2 when no severity is given', () => {
      expect(parseCommand('declare checkout is returning 502s')).toEqual({
        kind: 'declare',
        severity: 'sev2',
        title: 'checkout is returning 502s',
      });
    });

    it('reads a leading severity', () => {
      expect(parseCommand('declare sev1 payments are down')).toEqual({
        kind: 'declare',
        severity: 'sev1',
        title: 'payments are down',
      });
    });

    it('reads a trailing severity flag', () => {
      expect(parseCommand('declare payments are down --sev1')).toEqual({
        kind: 'declare',
        severity: 'sev1',
        title: 'payments are down',
      });
    });

    it('does not treat a severity word inside the title as a flag', () => {
      const parsed = parseCommand('declare alerting for sev3 pages is broken');
      expect(parsed).toEqual({
        kind: 'declare',
        severity: 'sev2',
        title: 'alerting for sev3 pages is broken',
      });
    });

    it('collapses runs of whitespace', () => {
      expect(parseCommand('  declare   sev3    slow   search  ')).toMatchObject({ title: 'slow search' });
    });

    it('rejects a declare with no title', () => {
      expect(() => parseCommand('declare')).toThrow(UsageError);
      expect(() => parseCommand('declare sev1')).toThrow(/Describe what is broken/);
    });

    it('rejects an overlong title', () => {
      expect(() => parseCommand(`declare ${'a'.repeat(201)}`)).toThrow(/under 200 characters/);
    });
  });

  describe('note', () => {
    it('takes the rest of the line as the note', () => {
      expect(parseCommand('note redis is at maxclients')).toEqual({
        kind: 'note',
        key: undefined,
        text: 'redis is at maxclients',
      });
    });

    it('pulls a leading incident key off the note', () => {
      expect(parseCommand('note INC-2026-0007 db failover finished')).toEqual({
        kind: 'note',
        key: 'INC-2026-0007',
        text: 'db failover finished',
      });
    });

    it('uppercases a lowercase key', () => {
      expect(parseCommand('note inc-2026-0007 back up')).toMatchObject({ key: 'INC-2026-0007' });
    });

    it('does not mistake a non-key first word for a key', () => {
      expect(parseCommand('note INC-BAD looks wrong')).toEqual({
        kind: 'note',
        key: undefined,
        text: 'INC-BAD looks wrong',
      });
    });

    it('rejects an empty note', () => {
      expect(() => parseCommand('note')).toThrow(UsageError);
      expect(() => parseCommand('note INC-2026-0007')).toThrow(/What happened/);
    });
  });

  describe('status', () => {
    it('accepts the open statuses', () => {
      expect(parseCommand('status identified')).toEqual({ kind: 'status', key: undefined, status: 'identified' });
      expect(parseCommand('status INC-2026-0007 monitoring')).toEqual({
        kind: 'status',
        key: 'INC-2026-0007',
        status: 'monitoring',
      });
    });

    it('redirects `status resolved` to the resolve command', () => {
      expect(() => parseCommand('status resolved')).toThrow(/incident resolve/);
    });

    it('rejects an unknown status', () => {
      expect(() => parseCommand('status fixed')).toThrow(UsageError);
    });
  });

  describe('resolve, list, help', () => {
    it('parses resolve with and without a key', () => {
      expect(parseCommand('resolve')).toEqual({ kind: 'resolve', key: undefined });
      expect(parseCommand('resolve INC-2026-0007')).toEqual({ kind: 'resolve', key: 'INC-2026-0007' });
    });

    it('defaults list to open incidents', () => {
      expect(parseCommand('list')).toEqual({ kind: 'list', scope: 'open' });
      expect(parseCommand('list all')).toEqual({ kind: 'list', scope: 'all' });
      expect(() => parseCommand('list closed')).toThrow(UsageError);
    });

    it('treats empty input as help', () => {
      expect(parseCommand('')).toEqual({ kind: 'help' });
      expect(parseCommand('   ')).toEqual({ kind: 'help' });
      expect(parseCommand('help')).toEqual({ kind: 'help' });
    });
  });

  it('accepts aliases', () => {
    expect(parseCommand('open sev1 everything is on fire')).toMatchObject({ kind: 'declare' });
    expect(parseCommand('log something happened')).toMatchObject({ kind: 'note' });
    expect(parseCommand('close')).toMatchObject({ kind: 'resolve' });
    expect(parseCommand('ls')).toMatchObject({ kind: 'list' });
  });

  it('names the unknown subcommand in the error', () => {
    expect(() => parseCommand('escalate now')).toThrow(/Unknown subcommand `escalate`/);
  });
});
