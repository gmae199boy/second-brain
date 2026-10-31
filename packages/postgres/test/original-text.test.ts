import { expect, it } from 'vitest';
import { originalJson, originalText } from '../src/original-text.js';
import { maskSecrets } from '@second-brain/core';

it('원형 TEXT와 JSON 중첩 키를 표시 치환 뒤에도 복원한다', () => {
  expect(originalText('a�b', Buffer.from([97,0,98]), 'utf-8')).toBe('a\0b');
  expect(originalText('a�b', null, null)).toBe('a�b');
  expect(originalText('�', Buffer.from([0xff]), 'utf-8')).toEqual({ type:'invalid-text', encoding:'utf-8', base64:'/w==' });
  expect(originalText('한글', Buffer.from('한글','utf16le'), 'utf-16le')).toBe('한글');
  expect(() => originalText('다름', Buffer.from([0]), 'utf-8')).toThrow('IMPORT_INVALID');
  const json = '{"a\\u0000b":{"a�b":"\\u0000"},"a�b":2}';
  expect(originalJson({}, Buffer.from(json), 'utf-8')).toEqual({'a\0b': {'a�b':'\0'}, 'a�b':2});
  expect(() => originalJson({bad:1}, Buffer.from(json), 'utf-8')).toThrow('IMPORT_INVALID');
  expect(originalJson({}, Buffer.from([0xff]), 'utf-8')).toEqual({type:'invalid-text',encoding:'utf-8',base64:'/w=='});
  expect(originalJson({}, Buffer.from('{bad'), 'utf-8')).toEqual({type:'invalid-json',text:'{bad'});
  const surrogate = '{"nested":{"\\ud800":"\\udfff","pair":"\\ud83d\\ude00"}}';
  expect(originalJson({}, Buffer.from(surrogate), 'utf-8')).toEqual({nested:{'\ud800':'\udfff',pair:'😀'}});
  expect(() => originalJson({nested:{}}, Buffer.from(surrogate), 'utf-8')).toThrow('IMPORT_INVALID');
  const secret = 'sk-AAAAAAAAAAAAAAAAAAAA';
  const restored = originalText(`원문� ${secret}`, Buffer.from(`원문\0 ${secret}`), 'utf-8');
  expect(typeof restored).toBe('string');
  const masked = maskSecrets(restored as string,'body');
  expect(masked.text).not.toContain(secret);
  expect(masked.text).toContain('\0');
});
