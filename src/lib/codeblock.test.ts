import { describe, it, expect } from 'vitest'
import { detectLanguage, isMultiline, oddLineNumbers } from './codeblock'

describe('detectLanguage', () => {
  it('detects a JSON object', () => {
    expect(detectLanguage('{"a": 1, "b": [2, 3]}')).toBe('json')
  })

  it('detects a JSON array', () => {
    expect(detectLanguage('[1, 2, 3]')).toBe('json')
  })

  it('detects a JSON string', () => {
    expect(detectLanguage('"just a string"')).toBe('json')
  })

  it('tolerates surrounding whitespace', () => {
    expect(detectLanguage('  \n  {"a": 1}\n  ')).toBe('json')
  })

  it('falls through invalid JSON that merely starts with a brace', () => {
    expect(detectLanguage('{not valid json')).toBe('plaintext')
  })

  it('detects a structlog-style key=value line', () => {
    expect(detectLanguage('level=info msg="task started" duration=1.2')).toBe('drakkar-log')
  })

  it('detects a line opening with an ISO/RFC3339 timestamp', () => {
    expect(detectLanguage('2024-01-02T03:04:05.678Z worker starting up')).toBe('drakkar-log')
  })

  it('detects a bare log-level token among plain lines', () => {
    expect(detectLanguage('first line is plain\nERROR: something bad happened')).toBe('drakkar-log')
  })

  it('is case-insensitive for the level= form', () => {
    expect(detectLanguage('LEVEL=WARN queue backing up')).toBe('drakkar-log')
  })

  it('is case-insensitive for a bare level token', () => {
    expect(detectLanguage('first line is plain\nerror: something bad happened')).toBe('drakkar-log')
  })

  it('falls back to plaintext for ordinary text', () => {
    expect(detectLanguage('just a plain line of text with no markers')).toBe('plaintext')
  })

  it('falls back to plaintext for empty input', () => {
    expect(detectLanguage('')).toBe('plaintext')
  })
})

describe('isMultiline', () => {
  it('is false for a short single-line string', () => {
    expect(isMultiline('short')).toBe(false)
  })

  it('is true when the text contains a newline, regardless of length', () => {
    expect(isMultiline('a\nb')).toBe(true)
  })

  it('is false right at the default threshold', () => {
    expect(isMultiline('x'.repeat(160))).toBe(false)
  })

  it('is true just past the default threshold', () => {
    expect(isMultiline('x'.repeat(161))).toBe(true)
  })

  it('honors a custom threshold', () => {
    expect(isMultiline('x'.repeat(10), 5)).toBe(true)
    expect(isMultiline('x'.repeat(5), 5)).toBe(false)
  })

  it('is false for an empty string', () => {
    expect(isMultiline('')).toBe(false)
  })
})

describe('oddLineNumbers', () => {
  it('returns an empty array for zero lines', () => {
    expect(oddLineNumbers(0)).toEqual([])
  })

  it('returns [1] for a single line', () => {
    expect(oddLineNumbers(1)).toEqual([1])
  })

  it('returns every odd line up to an odd lineCount', () => {
    expect(oddLineNumbers(5)).toEqual([1, 3, 5])
  })

  it('stops at the last odd number below an even lineCount', () => {
    expect(oddLineNumbers(6)).toEqual([1, 3, 5])
  })
})
